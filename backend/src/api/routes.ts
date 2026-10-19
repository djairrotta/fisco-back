import { OPERACOES, problemaValidacao } from "./v1/operacoes.ts";
import { type Context, Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { exigirSessao } from "../auth/session.ts";
import { liberarIpAdminGeo, registrarIpAdmin } from "../monitor/ips_admin.ts";
import type { WebauthnDeps } from "../auth/webauthn.ts";
import type { Notificacao, TipoEvento } from "../notify/notifier.ts";
import type { Papel } from "../ai/openrouter.ts";
import type { Relatorio } from "../ai/investigate.ts";
import { auditar, IpProtegido } from "../monitor/executor.ts";
import { asnValido, ipOuCidrValido } from "../monitor/geoblock.ts";
import {
  ipValido,
  JEV_LIMIAR_MAX,
  JEV_LIMIAR_MIN,
} from "../monitor/decision.ts";
import { lerConfigGeral } from "../scheduler.ts";
import { rotasAuth } from "./auth_routes.ts";
import { type ProvedorGeoIp, provedorIpwhois } from "../ip/localizar.ts";
import type { StatusZona } from "../monitor/protecoes.ts";
import { criarServicos, ErroApi } from "./servicos.ts";
import type { EstadoDisparo } from "../auditoria/execucao.ts";
import type { Campanha } from "../auditoria/ataque.ts";
import type { EntradaRevisao } from "../auditoria/revisor.ts";
import { montarIntegracoes } from "./v1/rotas.ts";
import { montarOAuthPwa, type OAuthOpcoes } from "./v1/oauth_rotas.ts";
import {
  criarToken,
  type Escopo,
  listarTokens,
  revogarToken,
} from "../auth/tokens.ts";
import type { ContentfulStatusCode } from "@hono/hono/utils/http-status";

/** Efeitos externos (Cloudflare, IA, push), já ligados às dependências reais. */
export interface Operacoes {
  bloquear(
    ip: string,
    incidenteId: number | null,
    motivo: string,
    ator: string,
    dias: number,
  ): Promise<{ bloqueioId: number }>;
  desfazer(
    id: number,
    ator: string,
  ): Promise<{ ok: true; jaRemovido: boolean }>;
  prorrogar(id: number, dias: number, ator: string): Promise<void>;
  /** Reaplica a regra geo (estado atual de geo_ativo) nas zonas monitoradas. */
  reaplicarGeo(): Promise<{ zonasComFalha: string[] }>;
  modoViagem(ip: string, horas: number): Promise<{ zonasComFalha: string[] }>;
  investigar(id: number): Promise<Relatorio | { erro: string }>;
  testarModelo(
    papel: Papel,
  ): Promise<
    { ok: boolean; latenciaMs: number; modelo: string; motivo?: string }
  >;
  notificar(tipo: TipoEvento, n: Notificacao): Promise<unknown>;
  /** Reaplica a regra "Vigia: proteções" e o rate limiting nas zonas. */
  aplicarProtecoes(): Promise<StatusZona[]>;
  /** Dispara a auditoria dos sites em segundo plano ("rodar agora"). */
  rodarAuditoria?(): Promise<{ estado: EstadoDisparo }>;
  /** true enquanto uma auditoria está em andamento. */
  auditoriaRodando?(): boolean;
  /** true quando EASYPANEL_URL e EASYPANEL_TOKEN estão definidos. */
  easypanelConfigurado?(): boolean;
  /**
   * Runner das checagens ATIVAS SEGURAS de uma campanha de teste ofensivo (só
   * contra staging do próprio Djair). Nada destrutivo roda aqui; a exploração
   * real exige um runner isolado opt-in.
   */
  executarAtaque?(c: Campanha): Promise<Record<string, unknown>>;
  /** Dispara o Revisor IA (análise caixa-preta) em segundo plano. */
  rodarRevisao?(
    entrada: EntradaRevisao,
  ): Promise<{ estado: "iniciada" | "ja_rodando" }>;
  /** true enquanto o Revisor está rodando. */
  revisaoRodando?(): boolean;
  /** Analisa um repositório (link do GitHub ou zip enviado) com o Revisor. */
  analisarRepo?(
    origem:
      | { tipo: "github"; url: string }
      | { tipo: "zip"; nome: string; bytes: Uint8Array },
  ): Promise<{ estado: "iniciada" | "ja_rodando" }>;
  /** true enquanto uma análise de código está rodando. */
  revisaoCodigoRodando?(): boolean;
  /** Aplica/desliga os cabeçalhos de segurança nas zonas; devolve por zona. */
  aplicarCabecalhos?(
    modo: "desligado" | "report-only" | "aplicar",
  ): Promise<
    { zona: string; estado: string; detalhe?: string }[]
  >;
  /** Audita as instâncias Supabase cadastradas, em segundo plano. */
  auditarSupabase?(): Promise<
    { estado: "iniciada" | "ja_rodando" | "sem_instancia" }
  >;
  /** true enquanto a auditoria do Supabase está rodando. */
  supabaseRodando?(): boolean;
  /** Reaplica a regra de skip do conector nas zonas; devolve as zonas com falha. */
  reaplicarConector?(): Promise<string[]>;
}

export interface ApiDeps {
  sql: Sql;
  agora: () => Date;
  webauthn: WebauthnDeps;
  ops: Operacoes;
  vapidPublic: string;
  /** Início do processo (carência de 3 min no /api/saude). Padrão: criação do app. */
  inicio?: Date;
  /** Provedor de localização de IP. Padrão: ipwho.is. */
  geoIp?: ProvedorGeoIp;
  /** Host do próprio Vigia (nunca conta como acesso estrangeiro que passou). */
  vigiaHost?: string;
  /** Limite por token da API/MCP (testes). Padrão: 60/min. */
  limitarTokens?: (tokenId: number) => number;
  /** Limites do registro dinâmico OAuth (testes). */
  oauth?: OAuthOpcoes;
}

const CARENCIA_BOOT_MS = 3 * 60_000;
const CICLO_MAX_ATRASO_MS = 5 * 60_000;

const PAPEIS = [
  "jev",
  "segunda",
  "terceira",
  "investigacao",
  "revisor",
] as const;
const ATOR = "usuario";
const DIA_MS = 86_400_000;
const LIMITE_CORPO = 64 * 1024;
/** Serviços de push aceitos (FCM, Apple, Mozilla, Windows). */
const HOSTS_PUSH = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^web\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];
export function endpointPushPermitido(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.port === "" &&
      HOSTS_PUSH.some((r) => r.test(url.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ util

async function corpo<T>(
  c: Context,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<{ ok: true; v: T } | { ok: false; r: Response }> {
  let bruto: unknown = {};
  const t = await c.req.text();
  if (t.trim()) {
    try {
      bruto = JSON.parse(t);
    } catch {
      return { ok: false, r: c.json({ erro: "JSON inválido" }, 400) };
    }
  }
  const p = schema.safeParse(bruto);
  if (!p.success) {
    return {
      ok: false,
      r: c.json({ erro: "Dados inválidos", detalhes: p.error.issues }, 400),
    };
  }
  return { ok: true, v: p.data };
}

function idParam(c: Context): number | null {
  const s = c.req.param("id") ?? "";
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

const msg = (e: unknown) => (e as Error)?.message ?? String(e);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
/** Diagnóstico da última chamada de cada papel de IA (sem chaves nem prompts). */
const diagnosticoIa = (r: Record<string, unknown>) => ({
  ultimoOkEm: iso(r.ultimo_ok_em),
  ultimoErroEm: iso(r.ultimo_erro_em),
  ultimoErro: (r.ultimo_erro as string | null) ?? null,
});

/** Duração de bloqueio/prorrogação escolhida no app: 24 h ou 7 dias (padrão). */
const Duracao = z.enum(["24h", "7d"]).default("7d");
const DIAS_DURACAO: Record<z.infer<typeof Duracao>, number> = {
  "24h": 1,
  "7d": 7,
};
const ATOR_DJAIR = "djair";
/** duracao (atual) ou {dias} legado por 1 release: 1 → 24h, outros → 7d. */
const CorpoDuracao = z.object({
  duracao: z.enum(["24h", "7d"]).optional(),
  dias: z.number().int().min(1).max(365).optional(),
}).strict().refine(
  (v) => v.duracao === undefined || v.dias === undefined,
  "Use duracao ou dias, não os dois",
);
const diasDoCorpo = (v: z.infer<typeof CorpoDuracao>): number =>
  v.duracao !== undefined
    ? DIAS_DURACAO[v.duracao]
    : v.dias !== undefined
    ? (v.dias === 1 ? 1 : 7)
    : 7;
/** Falha de cast do Postgres (ex.: ::inet) é erro do cliente, não 500. */
const ehCastInvalido = (e: unknown) =>
  (e as { code?: string } | null)?.code === "22P02";

const SchemaGeral = z.object({
  modoObservacao: z.boolean().optional(),
  geoAtivo: z.boolean().optional(),
  bloqueioAutoAtivo: z.boolean().optional(),
  limiares: z.object({
    bruteforceN: z.number().int().min(1).max(100_000).optional(),
    rateK: z.number().min(1).max(10_000).optional(),
  }).strict().optional(),
  jevLimiar: z.number().min(JEV_LIMIAR_MIN).max(JEV_LIMIAR_MAX).optional(),
  jevExigeSegunda: z.boolean().optional(),
  bloquearDatacenter: z.boolean().optional(),
}).strict();

const SchemaAsn = z.object({
  asn: z.number().int().min(1).max(4294967295),
  nome: z.string().trim().min(1).max(100),
}).strict();

const SchemaIa = z.array(
  z.object({
    papel: z.enum(PAPEIS),
    modelo: z.string().regex(/^[\w.\-]+\/[\w.:\-]+$/).max(200),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  }).strict(),
).min(1).max(10);

const SchemaNotif = z.array(
  z.object({
    tipo: z.string().min(1).max(50),
    push: z.boolean(),
    whatsapp: z.boolean(),
  }).strict(),
).min(1).max(50);

// ------------------------------------------------------------------ app

export function criarApp(deps: ApiDeps): Hono {
  const { sql, ops } = deps;
  const app = new Hono();

  app.onError((e, c) => {
    if (ehCastInvalido(e)) {
      // "IP" só quando a rota é de IP; nas demais, mensagem genérica.
      const deIp = c.req.path.startsWith("/api/ip/") ||
        (c.req.path === "/api/bloqueios" && c.req.method === "POST");
      return c.json({ erro: deIp ? "IP inválido" : "Valor inválido" }, 400);
    }
    console.error("[api] erro:", e);
    return c.json({ erro: "Erro interno" }, 500);
  });

  // Defesa CSRF + limite de corpo, antes de qualquer rota (inclui /api/auth/*).
  app.use("/api/*", async (c, next) => {
    const m = c.req.method;
    // /api/v1 usa token Bearer (sem cookie ambiente): sem CSRF a defender.
    if (c.req.path.startsWith("/api/v1/")) return await next();
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
      const ct = (c.req.header("Content-Type") ?? "").toLowerCase();
      if (!/^application\/json\s*(;|$)/.test(ct)) {
        return c.json({ erro: "Content-Type deve ser application/json" }, 415);
      }
      const site = c.req.header("Sec-Fetch-Site");
      if (site !== undefined && site !== "same-origin") {
        return c.json({ erro: "Requisição de outra origem recusada" }, 403);
      }
    }
    await next();
  });
  for (const p of ["/api/*", "/mcp", "/oauth/*"]) {
    app.use(
      p,
      bodyLimit({
        maxSize: LIMITE_CORPO,
        onError: (c) => c.json({ erro: "Corpo grande demais" }, 413),
      }),
    );
  }

  // Liveness para o HEALTHCHECK do container: só o processo, sem banco nem
  // ciclo (evita loop de restart). Monitoração externa usa /api/saude.
  app.get("/api/vivo", (c) => c.json({ ok: true }));

  const inicio = deps.inicio ?? deps.agora();
  app.get("/api/saude", async (c) => {
    const agora = deps.agora();
    let ultimo: unknown;
    try {
      const [r] = await sql`SELECT valor FROM vigia.config_geral
        WHERE chave = 'ciclo_ultimo_ok'`;
      ultimo = r?.valor;
    } catch (e) {
      return c.json({
        ok: false,
        motivo: `banco de dados inacessível: ${(e as Error).message}`,
      }, 503);
    }
    if (agora.getTime() - inicio.getTime() >= CARENCIA_BOOT_MS) {
      const t = typeof ultimo === "string" ? new Date(ultimo).getTime() : NaN;
      if (!Number.isFinite(t) || agora.getTime() - t > CICLO_MAX_ATRASO_MS) {
        return c.json({
          ok: false,
          motivo: Number.isFinite(t)
            ? `último ciclo concluído em ${ultimo} (há mais de 5 min)`
            : "nenhum ciclo concluído desde o início",
        }, 503);
      }
    }
    return c.json({ ok: true });
  });
  app.route("/api/auth", rotasAuth(sql, deps.webauthn));

  const sessao = exigirSessao(sql, deps.agora);
  app.use("/api/*", async (c, next) => {
    const p = c.req.path;
    if (
      p === "/api/saude" || p === "/api/vivo" || p.startsWith("/api/auth/") ||
      // Só token Bearer (montarIntegracoes); a sessão de passkey não vale lá.
      p.startsWith("/api/v1/")
    ) return await next();
    return await sessao(c, async () => {
      // IP de uso do administrador: protegido contra bloqueio por 7 dias.
      const ip = c.req.header("CF-Connecting-IP")?.trim();
      if (ip) {
        const agora = deps.agora();
        await registrarIpAdmin(sql, ip, agora);
        // Também isenta da regra de geo/datacenter na borda (não só do
        // bloqueio por incidente). Só reaplica na Cloudflare quando o IP
        // passou a vigorar agora — nunca atrasa a resposta por isso.
        if (await liberarIpAdminGeo(sql, ip, agora)) {
          ops.reaplicarGeo().catch((e) =>
            console.error(
              `geo: reaplicar após novo IP admin (${ip}) falhou: ${
                (e as Error).message
              }`,
            )
          );
        }
      }
      await next();
    });
  });

  const srv = criarServicos({
    sql,
    agora: deps.agora,
    ops,
    geoIp: deps.geoIp ?? provedorIpwhois(),
    vigiaHost: deps.vigiaHost,
  });
  const { estados, estadoDe } = srv;
  montarIntegracoes(app, {
    sql,
    agora: deps.agora,
    srv,
    origem: deps.webauthn?.cfg?.origin ?? "",
    limitar: deps.limitarTokens,
    oauth: deps.oauth,
  });
  // Consentimento (/oauth/autorizar) e apps autorizados: só com passkey.
  montarOAuthPwa(app, {
    sql,
    agora: deps.agora,
    origem: deps.webauthn?.cfg?.origin ?? "",
  });
  /** Executa o serviço; ErroApi vira a resposta JSON com o status dele. */
  const responder = async (c: Context, fn: () => Promise<unknown>) => {
    try {
      return c.json(await fn());
    } catch (e) {
      if (e instanceof ErroApi) {
        return c.json(e.corpo, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  };

  // ---------------------------------------------------------------- painel
  app.get("/api/painel", async (c) => {
    const agora = deps.agora();
    const desde = new Date(agora.getTime() - DIA_MS);
    const horas = await sql`
      SELECT to_char(h AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"') h,
        (SELECT count(*)::int FROM vigia.incidentes i
          WHERE i.inicio >= h AND i.inicio < h + interval '1 hour'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(i.sinais) x
              WHERE x->>'tipo' NOT IN ('geo', 'datacenter'))) n
      FROM generate_series(
        date_trunc('hour', ${agora}::timestamptz, 'UTC') - interval '23 hours',
        date_trunc('hour', ${agora}::timestamptz, 'UTC'),
        interval '1 hour') h
      ORDER BY h`;
    const topIps = await sql`
      SELECT host(ip) ip, sum(contagem)::float8 n, max(pais) pais
      FROM vigia.eventos WHERE ts >= ${desde} AND fonte = 'http'
      GROUP BY ip ORDER BY n DESC LIMIT 10`;
    const paises = await sql`
      SELECT COALESCE(NULLIF(pais, ''), '?') pais, sum(contagem)::float8 n
      FROM vigia.eventos WHERE ts >= ${desde} AND fonte = 'http'
      GROUP BY 1 ORDER BY n DESC LIMIT 15`;
    const hosts = await sql`
      SELECT host, sum(contagem)::float8 n
      FROM vigia.eventos WHERE ts >= ${desde} AND fonte = 'http'
      GROUP BY host ORDER BY n DESC LIMIT 15`;
    const cfg = await lerConfigGeral(sql);
    const falhas = Number(cfg.get("coletor_falhas") ?? 0) || 0;
    const ultimo = typeof cfg.get("coletor_ultimo_ok") === "string"
      ? String(cfg.get("coletor_ultimo_ok"))
      : "";
    const recente = ultimo !== "" &&
      agora.getTime() - new Date(ultimo).getTime() < 5 * 60_000;
    const ias = await sql`
      SELECT papel, modelo, degradado_desde IS NOT NULL AS degradado,
        ultimo_ok_em, ultimo_erro_em, ultimo_erro
      FROM vigia.config_ia WHERE papel <> 'revisor' ORDER BY papel`;
    const estTop = await estados(topIps.map((r) => String(r.ip)));
    return c.json({
      ataquesHora: horas.map((r) => ({ h: r.h, n: r.n })),
      topIps: topIps.map((r) => {
        const e = estadoDe(estTop, r.ip);
        return {
          ip: r.ip,
          n: r.n,
          pais: r.pais ?? "",
          bloqueado: e.bloqueado,
          bloqueadoAte: e.bloqueadoAte,
          geo: e.geo,
        };
      }),
      paises: paises.map((r) => ({ pais: r.pais, n: r.n })),
      hosts: hosts.map((r) => ({ host: r.host ?? "", n: r.n })),
      coletor: { ok: falhas === 0 && recente, ultimo },
      ias: ias.map((r) => ({
        papel: r.papel,
        modelo: r.modelo,
        degradado: r.degradado,
        ...diagnosticoIa(r),
      })),
    });
  });

  // ------------------------------------------------------------ incidentes
  app.get("/api/incidentes", async (c) => {
    const q = z.object({
      status: z.string().regex(/^[a-z_]{1,20}$/).optional(),
      limite: z.coerce.number().int().min(1).max(500).default(50),
    }).safeParse({
      status: c.req.query("status") || undefined,
      limite: c.req.query("limite") || undefined,
    });
    if (!q.success) return c.json({ erro: "Parâmetros inválidos" }, 400);
    return c.json(await srv.listarIncidentes(q.data));
  });

  app.get("/api/incidentes/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, () => srv.verIncidente(id));
  });

  app.post("/api/incidentes/:id/investigar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, () => srv.investigarIncidente(id));
  });

  app.post("/api/incidentes/:id/bloquear", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    const b = await corpo(c, CorpoDuracao);
    if (!b.ok) return b.r;
    const [inc] = await sql`
      SELECT ARRAY(SELECT host(x) FROM unnest(ips) x) ips
      FROM vigia.incidentes WHERE id = ${id}`;
    if (!inc) return c.json({ erro: "Incidente não encontrado" }, 404);
    const ids: number[] = [];
    const protegidos: { ip: string; motivo: string }[] = [];
    const ips = (inc.ips as string[]).slice(0, 50);
    try {
      for (const ip of ips) {
        try {
          const r = await ops.bloquear(
            ip,
            id,
            "Bloqueio manual pelo painel",
            ATOR,
            diasDoCorpo(b.v),
          );
          ids.push(r.bloqueioId);
        } catch (e) {
          if (!(e instanceof IpProtegido)) throw e;
          protegidos.push({ ip: e.ip, motivo: e.motivo });
        }
      }
    } catch (e) {
      if (ehCastInvalido(e)) return c.json({ erro: "Valor inválido" }, 400);
      if (ids.length) {
        await sql`UPDATE vigia.incidentes SET status = 'bloqueado' WHERE id = ${id}`;
      }
      return c.json({ erro: msg(e), bloqueioIds: ids, protegidos }, 502);
    }
    if (ids.length === 0) {
      return c.json({
        erro:
          "Todos os IPs do incidente são protegidos (permitidos ou do Cloudflare)",
        protegidos,
      }, 409);
    }
    await sql`UPDATE vigia.incidentes SET status = 'bloqueado' WHERE id = ${id}`;
    return c.json({ ok: true, bloqueioIds: ids, protegidos });
  });

  app.post("/api/incidentes/:id/ignorar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, async () => {
      await srv.ignorarIncidente(id, ATOR);
      return { ok: true };
    });
  });

  // -------------------------------------------------------------- bloqueios
  app.get(
    "/api/bloqueios",
    async (c) =>
      c.json(await srv.listarBloqueios(c.req.query("todos") === "1")),
  );

  // Bloqueio manual de um IP qualquer (sem incidente).
  app.post("/api/bloqueios", async (c) => {
    const b = await corpo(
      c,
      z.object({
        ip: z.string().trim().max(64).refine(ipValido, "IP inválido"),
        duracao: Duracao,
        motivo: z.string().trim().min(1).max(200).optional(),
      }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(c, async () => {
      const r = await srv.bloquearIp(b.v, ATOR_DJAIR);
      return { ok: true, bloqueioId: r.bloqueioId };
    });
  });

  app.post("/api/bloqueios/:id/desfazer", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, async () => {
      const { ok, jaRemovido } = await srv.desbloquear(id, ATOR);
      return { ok, jaRemovido };
    });
  });

  app.post("/api/bloqueios/:id/prorrogar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    const b = await corpo(c, CorpoDuracao);
    if (!b.ok) return b.r;
    return await responder(c, async () => {
      await srv.prorrogar(id, diasDoCorpo(b.v), ATOR);
      return { ok: true };
    });
  });

  // ------------------------------------------------------- localizar IP
  app.get(
    "/api/ip/:ip/local",
    async (c) =>
      await responder(c, () => srv.localizar(c.req.param("ip") ?? "")),
  );

  app.get("/api/ip/:ip/dossie", async (c) => {
    try {
      const t = await srv.dossie(c.req.param("ip") ?? "", ATOR);
      return c.text(t, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      if (e instanceof ErroApi) {
        return c.json(e.corpo, e.status as ContentfulStatusCode);
      }
      throw e;
    }
  });

  // ----------------------------------------------------------------- regras
  app.get("/api/excecoes", async (c) => c.json(await srv.listarExcecoes()));

  app.post("/api/excecoes", async (c) => {
    const b = await corpo(
      c,
      z.object({
        tipo: z.literal("caminho").default("caminho"),
        valor: z.string().min(1).max(200).regex(/^\/[^\s"\\]*$/),
        nota: z.string().max(200).optional(),
      }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(c, () => srv.adicionarExcecao(b.v, ATOR));
  });

  app.delete("/api/excecoes/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, async () => {
      const { removida: _r, ...resto } = await srv.removerExcecao(id, ATOR);
      return resto;
    });
  });

  app.get("/api/permitidos", async (c) => c.json(await srv.listarPermitidos()));
  app.get("/api/ips-servidor", async (c) => c.json(await srv.ipsServidor()));

  app.post("/api/permitidos", async (c) => {
    const b = await corpo(
      c,
      z.object({
        ip: z.string().max(64).refine(ipOuCidrValido, "IP ou CIDR inválido"),
        horas: z.number().positive().max(8760).optional(),
        nota: z.string().max(200).optional(),
      }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(c, async () => {
      const { ip: _ip, expira: _e, ...r } = await srv.adicionarPermitido(
        b.v,
        ATOR,
      );
      return r;
    });
  });

  app.delete("/api/permitidos/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, async () => {
      const { removido: _r, ...resto } = await srv.removerPermitido(id, ATOR);
      return resto;
    });
  });

  // ------------------------------------------- ASNs de datacenter/VPS
  app.get("/api/asn-datacenter", async (c) => c.json(await srv.listarAsns()));

  app.post("/api/asn-datacenter", async (c) => {
    const b = await corpo(c, SchemaAsn);
    if (!b.ok) return b.r;
    return await responder(c, () => srv.adicionarAsnDatacenter(b.v, ATOR));
  });

  app.delete("/api/asn-datacenter/:asn", async (c) => {
    const asn = Number(c.req.param("asn"));
    if (!asnValido(asn)) return c.json({ erro: "ASN inválido" }, 400);
    return await responder(c, () => srv.removerAsnDatacenter(asn, ATOR));
  });

  app.post("/api/modo-viagem", async (c) => {
    const b = await corpo(
      c,
      z.object({ horas: z.number().positive().max(720) }).strict(),
    );
    if (!b.ok) return b.r;
    const ip = c.req.header("CF-Connecting-IP")?.trim() ?? "";
    if (!ip || !ipOuCidrValido(ip)) {
      return c.json({
        erro: "IP do dispositivo indisponível (CF-Connecting-IP)",
      }, 400);
    }
    try {
      const r = await ops.modoViagem(ip, b.v.horas);
      await auditar(sql, ATOR, "modo_viagem", ip, { horas: b.v.horas });
      return c.json({ ok: true, ip, ...r });
    } catch (e) {
      return c.json({ erro: msg(e) }, 400);
    }
  });

  // --------------------------------------------------------- configurações
  app.get("/api/config/ia", async (c) => c.json(await srv.lerIa()));

  app.put("/api/config/ia", async (c) => {
    const b = await corpo(c, SchemaIa);
    if (!b.ok) return b.r;
    await srv.definirIa(b.v, ATOR);
    return c.json({ ok: true });
  });

  app.post("/api/config/ia/:papel/testar", async (c) => {
    const p = z.enum(PAPEIS).safeParse(c.req.param("papel"));
    if (!p.success) return c.json({ erro: "Papel inválido" }, 400);
    return c.json(await ops.testarModelo(p.data));
  });

  app.get("/api/config/notificacoes", async (c) => {
    const rows = await sql`SELECT tipo, push, whatsapp
      FROM vigia.config_notificacao ORDER BY tipo`;
    return c.json(rows.map((r) => ({ ...r })));
  });

  app.put("/api/config/notificacoes", async (c) => {
    const b = await corpo(c, SchemaNotif);
    if (!b.ok) return b.r;
    const tipos = new Set(
      (await sql`SELECT tipo FROM vigia.config_notificacao`).map((r) =>
        String(r.tipo)
      ),
    );
    const desconhecido = b.v.find((x) => !tipos.has(x.tipo));
    if (desconhecido) {
      return c.json({ erro: `Tipo desconhecido: ${desconhecido.tipo}` }, 400);
    }
    for (const x of b.v) {
      await sql`UPDATE vigia.config_notificacao
        SET push = ${x.push}, whatsapp = ${x.whatsapp} WHERE tipo = ${x.tipo}`;
    }
    return c.json({ ok: true });
  });

  app.get("/api/config/geral", async (c) => c.json(await srv.lerGeral()));

  app.put("/api/config/geral", async (c) => {
    const b = await corpo(c, SchemaGeral);
    if (!b.ok) return b.r;
    return await responder(c, async () => {
      const { antes: _a, ...r } = await srv.definirGeral(b.v, ATOR);
      return r;
    });
  });

  // ------------------------------------------- proteções na borda (1.4)
  app.get("/api/protecoes", async (c) => c.json(await srv.protecoes()));

  app.put("/api/protecoes", async (c) => {
    const b = await corpo(
      c,
      z.object({
        modo: z.enum(["desligado", "observar", "bloquear"]).optional(),
        rateAtivo: z.boolean().optional(),
      }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(c, () => srv.definirProtecoes(b.v, ATOR));
  });

  // ------------------------------- tokens da API/MCP (só com passkey)
  app.get("/api/tokens", async (c) => c.json(await listarTokens(sql)));

  app.post("/api/tokens", async (c) => {
    const b = await corpo(
      c,
      z.object({
        nome: z.string().trim().min(1).max(60).regex(
          /^[\p{L}\p{N} ._-]+$/u,
          "Use letras, números, espaço, ponto, _ ou -",
        ),
        escopo: z.enum(["ler", "escrever"]),
      }).strict(),
    );
    if (!b.ok) return b.r;
    const escopos: Escopo[] = b.v.escopo === "escrever"
      ? ["ler", "escrever"]
      : ["ler"];
    try {
      const r = await criarToken(sql, b.v.nome, escopos);
      await auditar(sql, ATOR, "token_criar", b.v.nome, {
        id: r.id,
        escopos,
      });
      return c.json(
        { id: r.id, nome: b.v.nome, escopos, token: r.token },
        201,
        {
          "Cache-Control": "no-store",
        },
      );
    } catch (e) {
      if ((e as { code?: string })?.code === "23505") {
        return c.json({ erro: "Já existe um token ativo com esse nome" }, 409);
      }
      throw e;
    }
  });

  app.post("/api/tokens/:id/revogar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    if (!await revogarToken(sql, id, deps.agora)) {
      return c.json({ erro: "Token não encontrado ou já revogado" }, 404);
    }
    await auditar(sql, ATOR, "token_revogar", String(id), {});
    return c.json({ ok: true });
  });

  // ------------------------------------------------- auditoria dos sites
  app.get("/api/auditoria", async (c) => c.json(await srv.achadosAuditoria()));

  app.get("/api/auditoria/prompt", async (c) => {
    return await responder(c, () => srv.promptCorrecao(c.req.query("host")));
  });

  // ------------------------------------------------ apps do EasyPanel
  app.get("/api/apps", async (c) => c.json(await srv.apps()));

  // ------------------------------------------------ servidor (host)
  app.get("/api/servidor", async (c) => responder(c, () => srv.servidorResumo()));
  app.get("/api/servidor/smart", async (c) => responder(c, () => srv.servidorSmart(ATOR)));
  app.get("/api/servidor/ssh", async (c) => responder(c, () => srv.servidorChave()));
  app.get("/api/servidor/comandos", (c) => c.json(srv.servidorCatalogo()));
  app.post("/api/servidor/comando", async (c) => {
    const op = OPERACOES.find((o) => o.nome === "servidor_comando")!;
    const v = op.entrada.safeParse(await c.req.json().catch(() => ({})));
    if (!v.success) return c.json({ erro: problemaValidacao(v.error) }, 400);
    return await responder(c, () => op.executar(srv, v.data, { ator: ATOR }));
  });
  app.post("/api/servidor/teste-disco", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const mb = Number((b as { mb?: unknown }).mb ?? 512);
    if (!Number.isInteger(mb) || mb < 64 || mb > 2048) {
      return c.json({ erro: "mb deve ser inteiro entre 64 e 2048" }, 400);
    }
    return await responder(c, () => srv.servidorTesteDisco(mb, ATOR));
  });

  app.post("/api/auditoria/rodar", async (c) => {
    return await responder(c, () => srv.rodarAuditoria(ATOR));
  });

  // -------------------------------------------------- Revisor IA
  app.get("/api/revisao", async (c) => c.json(await srv.achadosRevisao()));
  app.post("/api/revisao/rodar", async (c) => {
    return await responder(c, () => srv.rodarRevisao(ATOR));
  });

  // ------------------------------------------ cabeçalhos de segurança (CF)
  app.get("/api/cabecalhos", async (c) => c.json(await srv.verCabecalhos()));
  app.put("/api/cabecalhos", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return await responder(c, () => srv.definirCabecalhos(b?.modo, ATOR));
  });

  // ------------------------------------------------- auditoria do Supabase
  app.get("/api/supabase", async (c) => c.json(await srv.achadosSupabase()));
  app.post("/api/supabase", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return await responder(
      c,
      () => srv.adicionarSupabase(b?.nome, b?.url, b?.anonKey, ATOR),
    );
  });
  app.delete("/api/supabase/:nome", async (c) => {
    return await responder(
      c,
      () => srv.removerSupabase(c.req.param("nome"), ATOR),
    );
  });
  app.post("/api/supabase/auditar", async (c) => {
    return await responder(c, () => srv.auditarSupabaseAgora(ATOR));
  });

  // ------------------------------------------- conectores (pedidos/decisão)
  app.get("/api/conector", async (c) => c.json(await srv.pedidosConector()));
  app.post("/api/conector/pedidos/:id/decidir", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await c.req.json().catch(() => ({}));
    return await responder(
      c,
      () => srv.decidirConector({ id, modo: b?.modo, horas: b?.horas }, ATOR),
    );
  });
  app.post("/api/conector/decidir", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return await responder(
      c,
      () => srv.decidirConector({ faixa: b?.faixa, modo: b?.modo, horas: b?.horas }, ATOR),
    );
  });

  // -------------------------------------------- análise de código (zip/GitHub)
  app.get("/api/codigo", async (c) => c.json(await srv.achadosCodigo()));
  app.post("/api/codigo/github", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const url = typeof b?.url === "string" ? b.url : "";
    return await responder(c, () => srv.analisarRepoGithub(url, ATOR));
  });
  app.post("/api/codigo/zip", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const f = form?.get("arquivo");
    if (!(f instanceof File)) {
      return c.json(
        { erro: "Envie o campo 'arquivo' (zip do repositório)" },
        400,
      );
    }
    if (f.size > 25 * 1024 * 1024) {
      return c.json({ erro: "Zip maior que 25 MB" }, 413);
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const nome = (f.name || "repo.zip").slice(0, 100);
    return await responder(c, () => srv.analisarRepoZip(nome, bytes, ATOR));
  });

  app.post("/api/auditoria/hosts", async (c) => {
    const b = await corpo(
      c,
      z.object({ host: z.string().trim().min(1).max(253) }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(
      c,
      () => srv.adicionarHostAuditoria(b.v.host, ATOR),
    );
  });

  app.delete("/api/auditoria/hosts/:host", async (c) => {
    const host = c.req.param("host") ?? "";
    return await responder(c, () => srv.removerHostAuditoria(host, ATOR));
  });

  app.put("/api/auditoria/hosts/:host/ambiente", async (c) => {
    const host = c.req.param("host") ?? "";
    const b = await corpo(
      c,
      z.object({ ambiente: z.enum(["producao", "teste"]) }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(
      c,
      () => srv.definirAmbienteHost(host, b.v.ambiente, ATOR),
    );
  });

  // -------------------------------------- varredura profunda (segura)
  app.get("/api/varredura", async (c) => c.json(await srv.listarVarredura()));
  app.post("/api/varredura/rodar", async (c) => {
    return await responder(c, () => srv.rodarVarredura(ATOR));
  });

  // --------------------------- campanhas de teste ofensivo (staging)
  app.get("/api/ataque", async (c) => c.json(await srv.listarCampanhas()));

  app.post("/api/ataque", async (c) => {
    const b = await corpo(
      c,
      z.object({
        alvo: z.string().trim().min(1).max(300),
        tipo: z.enum(["forca_bruta_simulada", "fuzz_leve", "enumeracao"]),
        config: z.object({
          caminho: z.string().trim().max(300).optional(),
          caminhos: z.array(z.string().trim().max(300)).max(10).optional(),
        }).strict().optional(),
      }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(c, () => srv.criarCampanha(b.v, ATOR));
  });

  app.get("/api/ataque/:id", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, () => srv.verCampanha(id));
  });

  app.post("/api/ataque/:id/autorizar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    const b = await corpo(
      c,
      z.object({ confirmar: z.string().min(1).max(100) }).strict(),
    );
    if (!b.ok) return b.r;
    return await responder(
      c,
      () => srv.autorizarCampanha(id, b.v.confirmar, ATOR),
    );
  });

  app.post("/api/ataque/:id/rodar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, () => srv.rodarCampanha(id, ATOR));
  });

  app.post("/api/ataque/:id/cancelar", async (c) => {
    const id = idParam(c);
    if (id === null) return c.json({ erro: "id inválido" }, 400);
    return await responder(c, () => srv.cancelarCampanha(id, ATOR));
  });

  // ------------------------------------------------------------------- push
  app.post("/api/push/inscrever", async (c) => {
    const b = await corpo(
      c,
      z.object({
        endpoint: z.string().url().max(2000).refine(
          endpointPushPermitido,
          "Serviço de push não reconhecido",
        ),
        expirationTime: z.number().nullable().optional(),
        keys: z.object({
          p256dh: z.string().min(1).max(500),
          auth: z.string().min(1).max(500),
        }),
      }),
    );
    if (!b.ok) return b.r;
    await sql`INSERT INTO vigia.push_inscricoes (endpoint, chaves)
      VALUES (${b.v.endpoint}, ${sql.json(b.v.keys)})
      ON CONFLICT (endpoint) DO UPDATE SET chaves = EXCLUDED.chaves`;
    return c.json({ ok: true });
  });

  app.get(
    "/api/push/chave-publica",
    (c) => c.json({ chave: deps.vapidPublic }),
  );

  return app;
}
