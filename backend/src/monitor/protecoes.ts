// Vigia 2.0 (1.4): regra "Vigia: proteções" (assinaturas de XSS, SQLi,
// path traversal e sondagens) e rate limiting dos caminhos de autenticação,
// uma de cada por zona. Regra a regra: nunca PUT sobre entrypoint existente,
// nunca apaga regras que o Vigia não criou.
import type { Sql } from "../db/client.ts";
import { CfError } from "../cloudflare/client.ts";
import { VIGIA_HOST_PADRAO } from "../config.ts";
import {
  auditar,
  comRetry,
  type ExecutorDeps,
  FASE_CUSTOM,
  FASE_RATELIMIT,
  garantirRegraZona,
  REGRA_BLOQUEIO,
  type RegraCf,
} from "./executor.ts";
import { condicaoCaminho, DESCRICAO_GEO, esc } from "./geoblock.ts";

export const DESCRICAO_PROTECOES = "Vigia: proteções";
export const DESCRICAO_RATE = "Vigia: limite de login";
export const LIMITE_REGRAS_FREE = 5;
export const LIMITE_RATE_FREE = 1;
/** Regras do Vigia que têm vaga garantida antes da de proteções. */
const RESERVADAS = [REGRA_BLOQUEIO.description, DESCRICAO_GEO];
const LIMITE_EXPRESSAO = 4000;

/** Assinaturas conservadoras, comparadas com a URI decodificada e minúscula. */
export const ASSINATURAS = {
  xss: [
    "<script",
    "javascript:",
    "onerror=",
    "onload=",
    "<svg/onload",
    "document.cookie",
  ],
  sqli: [
    "union select",
    "' or '1'='1",
    "or 1=1--",
    "sleep(",
    "benchmark(",
    "information_schema",
    "pg_sleep",
    ";--",
  ],
  traversal: ["../", "%2e%2e", "/etc/passwd"],
  // Com a barra: "/.env" e "/.git/" (não casa "/environment" nem "x.envelope").
  sondagem: ["/.env", "/.git/"],
} as const;

const TODAS: string[] = Object.values(ASSINATURAS).flat();

export type ModoProtecao = "desligado" | "observar" | "bloquear";
export const MODOS: readonly ModoProtecao[] = [
  "desligado",
  "observar",
  "bloquear",
];

export type EstadoRegra =
  | "ativa"
  | "observando"
  | "observando_eventos"
  | "desligada"
  | "limite_plano"
  | "sem_permissao"
  | "nao_suportado"
  | "erro";
export type EstadoRate =
  | "ativo"
  | "desligado"
  | "limite_plano"
  | "sem_permissao"
  | "nao_suportado"
  | "erro";

export interface StatusZona {
  zona: string;
  regra: EstadoRegra;
  rate: EstadoRate;
  detalhe: string | null;
  atualizadoEm?: string;
}

/**
 * Bloqueia a URI (caminho + query) decodificada e minúscula que contenha
 * alguma assinatura; fora os caminhos de exceção (webhooks) e o host do Vigia.
 */
export function expressaoProtecoes(
  excecoesCaminho: string[],
  vigiaHost: string = VIGIA_HOST_PADRAO,
): string {
  const uri = "lower(url_decode(http.request.uri))";
  const sinais = TODAS.map((a) => `${uri} contains "${esc(a)}"`).join(" or ");
  const H = vigiaHost ? ` and http.host ne "${esc(vigiaHost)}"` : "";
  const E = excecoesCaminho.length
    ? ` and not (${excecoesCaminho.map(condicaoCaminho).join(" or ")})`
    : "";
  const expr = `(${sinais})${H}${E}`;
  if (expr.length > LIMITE_EXPRESSAO) {
    throw new Error(
      `A expressão de proteções ficou com ${expr.length} caracteres (limite ${LIMITE_EXPRESSAO}) — reduza as exceções de caminho`,
    );
  }
  return expr;
}

export const CAMINHOS_AUTH = [
  "/auth",
  "/login",
  "/token",
  "/signup",
  "/recover",
  "/otp",
];

const condRate = () =>
  `(${
    CAMINHOS_AUTH.map((p) => `http.request.uri.path contains "${p}"`).join(
      " or ",
    )
  })`;

/**
 * Caminhos de autenticação, fora as exceções de caminho (webhooks) e o host
 * do Vigia (que tem o próprio limite de tentativas).
 */
export function expressaoRate(
  excecoesCaminho: string[] = [],
  vigiaHost: string = VIGIA_HOST_PADRAO,
): string {
  const H = vigiaHost ? ` and http.host ne "${esc(vigiaHost)}"` : "";
  const E = excecoesCaminho.length
    ? ` and not (${excecoesCaminho.map(condicaoCaminho).join(" or ")})`
    : "";
  return `${condRate()}${H}${E}`;
}

/**
 * Plano Free: só o campo Path, sem funções nem regex. Exclui as exceções
 * exatas; prefixos e o host do Vigia não são expressáveis.
 */
export function expressaoRateFree(excecoesCaminho: string[] = []): string {
  const exatas = excecoesCaminho.filter((c) => !c.endsWith("*"));
  const E = exatas.length
    ? ` and not (${
      exatas.map((c) => `http.request.uri.path eq "${esc(c)}"`).join(" or ")
    })`
    : "";
  return `${condRate()}${E}`;
}

/** 1 regra, contagem por IP, período e bloqueio de 10 s (cabe no Free). */
export const REGRA_RATE: RegraCf = {
  description: DESCRICAO_RATE,
  expression: expressaoRate(),
  action: "block",
  enabled: true,
  ratelimit: {
    characteristics: ["cf.colo.id", "ip.src"],
    period: 10,
    requests_per_period: 20,
    mitigation_timeout: 10,
  },
};

/** Para o modo "observar" sem a ação log: assinatura que casa com a URI. */
export function casaAssinatura(uri: string): string | null {
  let d = uri;
  try {
    d = decodeURIComponent(uri.replaceAll("+", " "));
  } catch {
    d = uri.replaceAll("+", " ");
  }
  d = d.toLowerCase();
  return TODAS.find((a) => d.includes(a)) ?? null;
}

export type FalhaCf = "sem_permissao" | "nao_suportado" | "cota";

const RE_PERMISSAO =
  /permission|unauthori[sz]ed|authentication|forbidden|access denied|not authorized/i;
const RE_COTA = /quota|exceed|maximum|too many rules|limit reached/i;
const RE_NAO_SUPORTADO =
  /function|field|operator|action|not supported|unsupported|entitle|not allowed|not available|plan|upgrade/i;

/**
 * Classifica um 4xx do Cloudflare: falta de permissão do token, recurso não
 * suportado no plano (função, campo, ação log) ou cota de regras. null =
 * outro erro (vai como "erro").
 */
export function classificarFalhaCf(e: unknown): FalhaCf | null {
  if (
    !(e instanceof CfError) || e.status < 400 || e.status >= 500 ||
    e.status === 404 || e.status === 429
  ) return null;
  const t = e.messages.join(" ");
  if (e.status === 401 || RE_PERMISSAO.test(t)) return "sem_permissao";
  if (RE_COTA.test(t)) return "cota";
  if (RE_NAO_SUPORTADO.test(t)) return "nao_suportado";
  return null;
}

const textoCf = (e: unknown) =>
  e instanceof CfError ? e.messages.join("; ") : String(e);
const semPermissao = (e: unknown) => ({
  estado: "sem_permissao" as const,
  detalhe:
    `o token do Cloudflare não tem permissão para editar as regras desta zona (dê "Zone WAF: Edit"): ${
      textoCf(e)
    }`,
});
const naoSuportado = (e: unknown) => ({
  estado: "nao_suportado" as const,
  detalhe: `o plano da zona não suporta um recurso usado pela regra: ${
    textoCf(e)
  }`,
});

const msg = (e: unknown) => (e as Error)?.message ?? String(e);

export async function protecoesAtuais(sql: Sql): Promise<{
  modo: ModoProtecao;
  rateAtivo: boolean;
  zonas: StatusZona[];
}> {
  const cfg = await sql`SELECT chave, valor FROM vigia.config_geral
    WHERE chave IN ('protecoes_modo', 'protecoes_rate_ativo')`;
  const m = new Map(cfg.map((r) => [String(r.chave), r.valor]));
  const modo = MODOS.includes(m.get("protecoes_modo") as ModoProtecao)
    ? m.get("protecoes_modo") as ModoProtecao
    : "observar";
  const zonas = await sql`SELECT cf_zone_id, regra, rate, detalhe,
      atualizado_em FROM vigia.protecoes_zona ORDER BY cf_zone_id`;
  return {
    modo,
    rateAtivo: m.get("protecoes_rate_ativo") !== false,
    zonas: zonas.map((z) => ({
      zona: String(z.cf_zone_id),
      regra: z.regra as EstadoRegra,
      rate: z.rate as EstadoRate,
      detalhe: z.detalhe ?? null,
      atualizadoEm: new Date(z.atualizado_em).toISOString(),
    })),
  };
}

type CfRuleset = { id: string; rules?: (RegraCf & { id: string })[] };

async function lerFase(
  deps: ExecutorDeps,
  zona: string,
  fase: string,
): Promise<CfRuleset | null> {
  try {
    return await comRetry(deps, () =>
      deps.api.rest<CfRuleset>(
        "GET",
        `/zones/${zona}/rulesets/phases/${fase}/entrypoint`,
      ));
  } catch (e) {
    if (e instanceof CfError && e.status === 404) return null;
    throw e;
  }
}

async function aplicarRegra(
  deps: ExecutorDeps,
  zona: string,
  modo: ModoProtecao,
  expressao: string,
): Promise<{ estado: EstadoRegra; detalhe?: string }> {
  const rs = await lerFase(deps, zona, FASE_CUSTOM);
  const regras = rs?.rules ?? [];
  const existente = regras.find((r) => r.description === DESCRICAO_PROTECOES);
  const base: RegraCf = {
    description: DESCRICAO_PROTECOES,
    expression: expressao,
    action: "block",
    enabled: true,
  };
  const garantir = (r: RegraCf) =>
    comRetry(deps, () => garantirRegraZona(deps.api, zona, r, FASE_CUSTOM));
  if (modo === "desligado") {
    if (existente && existente.enabled) {
      await garantir({
        ...base,
        expression: existente.expression,
        enabled: false,
      });
    }
    return { estado: "desligada" };
  }
  // Conta antes do POST: a regra de proteções nunca ocupa a vaga das regras
  // do Vigia que ainda faltam (bloqueados, fora do Brasil).
  const faltando = RESERVADAS.filter((d) =>
    !regras.some((r) => r.description === d)
  );
  const ocupadas = regras.length + faltando.length;
  const cheia = !existente && ocupadas >= LIMITE_REGRAS_FREE;
  const limite = () => ({
    estado: "limite_plano" as const,
    detalhe: `zona já usa ${regras.length} regras personalizadas${
      faltando.length
        ? ` e reserva ${faltando.length} para ${
          faltando.map((d) => `"${d}"`).join(" e ")
        }`
        : ""
    } (o plano Free permite ${LIMITE_REGRAS_FREE} regras); a regra de proteções não coube`,
  });
  if (cheia) return limite();
  /** Falha conhecida vira estado; cota só é limite com a zona cheia. */
  const mapear = (e: unknown) => {
    const f = classificarFalhaCf(e);
    if (f === "sem_permissao") return semPermissao(e);
    if (f === "nao_suportado") return naoSuportado(e);
    throw e;
  };
  if (modo === "observar") {
    try {
      await garantir({ ...base, action: "log" });
      return { estado: "observando" };
    } catch (e) {
      if (classificarFalhaCf(e) !== "nao_suportado") return mapear(e);
      // Sem a ação log no plano: desativa a nossa (se houver) e observa pelos eventos.
      if (existente && (existente.enabled || existente.action !== "block")) {
        await garantir({ ...base, enabled: false });
      }
      return {
        estado: "observando_eventos",
        detalhe:
          "o plano não permite a ação log; observando pelos eventos coletados",
      };
    }
  }
  try {
    await garantir(base);
    return { estado: "ativa" };
  } catch (e) {
    return mapear(e);
  }
}

async function aplicarRate(
  deps: ExecutorDeps,
  zona: string,
  ativo: boolean,
  excecoes: string[],
): Promise<{ estado: EstadoRate; detalhe?: string }> {
  const rs = await lerFase(deps, zona, FASE_RATELIMIT);
  const regras = rs?.rules ?? [];
  const ex = regras.find((r) => r.description === DESCRICAO_RATE);
  if (!ativo) {
    if (ex && ex.enabled) {
      await comRetry(deps, () =>
        garantirRegraZona(
          deps.api,
          zona,
          { ...REGRA_RATE, expression: ex.expression, enabled: false },
          FASE_RATELIMIT,
        ));
    }
    return { estado: "desligado" };
  }
  const garantir = (expression: string) =>
    comRetry(
      deps,
      () =>
        garantirRegraZona(
          deps.api,
          zona,
          { ...REGRA_RATE, expression },
          FASE_RATELIMIT,
        ),
    );
  const mapear = (e: unknown): { estado: EstadoRate; detalhe?: string } => {
    const f = classificarFalhaCf(e);
    if (f === "sem_permissao") return semPermissao(e);
    if (f === "nao_suportado") return naoSuportado(e);
    if (f === "cota" && !ex && regras.length >= LIMITE_RATE_FREE) {
      return {
        estado: "limite_plano",
        detalhe:
          `rate limiting não aplicado: a zona já usa ${regras.length} regra(s) de rate limiting (o plano Free permite ${LIMITE_RATE_FREE})`,
      };
    }
    throw e;
  };
  try {
    await garantir(
      expressaoRate(excecoes, deps.cfg.vigiaHost ?? VIGIA_HOST_PADRAO),
    );
    return { estado: "ativo" };
  } catch (e) {
    if (classificarFalhaCf(e) !== "nao_suportado") return mapear(e);
  }
  // Plano Free: só o campo Path (sem host nem funções).
  try {
    await garantir(expressaoRateFree(excecoes));
    return {
      estado: "ativo",
      detalhe:
        "o plano só aceita o campo Path no rate limiting: o host do Vigia e as exceções de prefixo (*) não ficam de fora do limite de login",
    };
  } catch (e) {
    return mapear(e);
  }
}

/**
 * Aplica o modo e o rate limiting configurados em cada zona. Nunca lança por
 * zona: o resultado (e o motivo) fica em vigia.protecoes_zona.
 */
export async function sincronizarProtecoes(
  deps: ExecutorDeps,
  zonas: string[],
): Promise<StatusZona[]> {
  const { sql } = deps;
  const atual = await protecoesAtuais(sql);
  const exc = await sql`
    SELECT valor FROM vigia.excecoes WHERE tipo = 'caminho' ORDER BY id`;
  const excecoes = exc.map((r) => String(r.valor));
  let expressao: string | null = null;
  let erroExpr: string | null = null;
  try {
    expressao = expressaoProtecoes(
      excecoes,
      deps.cfg.vigiaHost ?? VIGIA_HOST_PADRAO,
    );
  } catch (e) {
    erroExpr = msg(e);
  }
  const anteriores = new Map(atual.zonas.map((z) => [z.zona, z]));
  const out: StatusZona[] = [];
  for (const zona of zonas) {
    const detalhes: string[] = [];
    let regra: EstadoRegra;
    let rate: EstadoRate;
    try {
      if (expressao === null) throw new Error(erroExpr ?? "expressão inválida");
      const r = await aplicarRegra(deps, zona, atual.modo, expressao);
      regra = r.estado;
      if (r.detalhe) detalhes.push(r.detalhe);
    } catch (e) {
      regra = "erro";
      detalhes.push(`proteções: ${msg(e)}`);
    }
    try {
      const r = await aplicarRate(deps, zona, atual.rateAtivo, excecoes);
      rate = r.estado;
      if (r.detalhe) detalhes.push(r.detalhe);
    } catch (e) {
      rate = "erro";
      detalhes.push(`rate limiting: ${msg(e)}`);
    }
    const detalhe = detalhes.length ? detalhes.join(" · ") : null;
    out.push({ zona, regra, rate, detalhe });
    const ant = anteriores.get(zona);
    await sql`INSERT INTO vigia.protecoes_zona
        (cf_zone_id, regra, rate, detalhe, atualizado_em)
      VALUES (${zona}, ${regra}, ${rate}, ${detalhe}, ${deps.agora()})
      ON CONFLICT (cf_zone_id) DO UPDATE SET regra = EXCLUDED.regra,
        rate = EXCLUDED.rate, detalhe = EXCLUDED.detalhe,
        atualizado_em = EXCLUDED.atualizado_em`;
    if (!ant || ant.regra !== regra || ant.rate !== rate) {
      try {
        await auditar(sql, "sistema", "protecoes", zona, {
          regra,
          rate,
          detalhe,
        });
      } catch (e) {
        console.error(`protecoes: auditoria falhou: ${msg(e)}`);
      }
    }
  }
  return out;
}

/** Quantas requisições das últimas 24 h casaram uma assinatura (modo observar). */
export async function ocorrenciasRecentes(
  sql: Sql,
  agora: Date,
): Promise<{ total: number; porAssinatura: Record<string, number> }> {
  const rows = await sql`
    SELECT caminho, sum(contagem)::float8 n FROM vigia.eventos
    WHERE ts >= ${new Date(agora.getTime() - 86_400_000)} AND fonte = 'http'
      AND (caminho ILIKE '%\\%%' OR caminho ~* '[<>''";.]|union|sleep|benchmark|information_schema|passwd|javascript|onerror|onload|cookie')
    GROUP BY caminho LIMIT 5000`;
  const porAssinatura: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    const a = casaAssinatura(String(r.caminho));
    if (!a) continue;
    porAssinatura[a] = (porAssinatura[a] ?? 0) + Number(r.n);
    total += Number(r.n);
  }
  return { total, porAssinatura };
}
