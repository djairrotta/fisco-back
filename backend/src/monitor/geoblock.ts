import { isIP } from "node:net";
import type { Sql } from "../db/client.ts";
import { VIGIA_HOST_PADRAO } from "../config.ts";
import { auditar, comRetry, garantirRegraZona } from "./executor.ts";
import type { ExecutorDeps, RegraCf } from "./executor.ts";
import { faixasConectorTabela } from "./vendores.ts";

export { DESCRICAO_GEO } from "./estrangeiro.ts";
import { DESCRICAO_GEO } from "./estrangeiro.ts";
export const LIMITE_EXPRESSAO = 4000;

/**
 * Faixa de datacenter da Anthropic de onde o conector MCP se conecta (fluxo
 * OAuth + chamadas a /mcp). Fica EMBUTIDA para o conector/admin nunca ser
 * barrado pela WAF gerenciada da Cloudflare (bloqueio de bots de IA / Super Bot
 * Fight Mode), que roda numa fase separada que o Vigia não administra — e sem
 * depender da lista de "permitidos" (que pode se perder num redeploy).
 */
export const FAIXA_CONECTOR_PADRAO = ["160.79.104.0/21"];
/** Caminhos do conector/admin cobertos pela regra de skip. */
export const CAMINHOS_CONECTOR = [
  "/mcp*",
  "/oauth/*",
  "/.well-known/*",
  "/api/v1/*",
];
export const DESCRICAO_CONECTOR = "Vigia: conector";
/** ASN público de 32 bits (1..4294967295). */
export const asnValido = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 4294967295;
const HORA_MS = 3_600_000;

export function excecoesPadrao(): string[] {
  return [
    "/functions/v1/infosimples-callback*",
    "/functions/v1/email-tracking*",
    "/functions/v1/whatsapp-webhook*",
    "/functions/v1/whatsapp-baileys*",
    "/api/asaas/webhook*",
    "/webhooks/asaas*",
    "/.well-known/acme-challenge/*",
  ];
}

export async function semearExcecoesPadrao(sql: Sql): Promise<void> {
  for (const valor of excecoesPadrao()) {
    await sql`
      INSERT INTO vigia.excecoes (tipo, valor, nota)
      SELECT 'caminho', ${valor}, 'padrão'
      WHERE NOT EXISTS (
        SELECT 1 FROM vigia.excecoes WHERE tipo = 'caminho' AND valor = ${valor})`;
  }
}

/** Aceita IPv4, IPv6 ou CIDR; qualquer outra coisa é rejeitada. */
export function ipOuCidrValido(s: string): boolean {
  if (typeof s !== "string" || s !== s.trim() || s === "") return false;
  const [ip, pfx, ...resto] = s.split("/");
  if (resto.length) return false;
  if (ip.includes("%")) return false; // IPv6 com zone id
  const v = isIP(ip);
  if (!v) return false;
  if (pfx === undefined) return true;
  if (!/^\d{1,3}$/.test(pfx)) return false;
  const n = Number(pfx);
  // prefixos muito amplos liberariam faixas enormes do mundo
  return v === 4 ? n >= 8 && n <= 32 : n >= 16 && n <= 128;
}

export const esc = (s: string) =>
  s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export function condicaoCaminho(c: string): string {
  return c.endsWith("*")
    ? `starts_with(http.request.uri.path, "${esc(c.slice(0, -1))}")`
    : `http.request.uri.path eq "${esc(c)}"`;
}

/**
 * Regra "Vigia: fora do Brasil": barra quem vem de fora do Brasil OU de um ASN
 * de datacenter/VPS (`asnsDatacenter`, mesmo do Brasil), exceto bots
 * verificados (cf.client.bot), o host do Vigia, IPs permitidos e os caminhos de
 * exceção (webhooks). Sem ASNs, a expressão é a mesma de antes.
 */
export function expressaoGeo(
  excecoesCaminho: string[],
  permitidos: string[],
  vigiaHost: string = VIGIA_HOST_PADRAO,
  asnsDatacenter: number[] = [],
): string {
  for (const p of permitidos) {
    if (!ipOuCidrValido(p)) {
      throw new Error(`IP permitido inválido: "${p}" (use IPv4, IPv6 ou CIDR)`);
    }
  }
  for (const a of asnsDatacenter) {
    if (!asnValido(a)) throw new Error(`ASN de datacenter inválido: "${a}"`);
  }
  const origem = asnsDatacenter.length
    ? `(ip.src.country ne "BR" or ip.src.asnum in {${
      asnsDatacenter.join(" ")
    }})`
    : `ip.src.country ne "BR"`;
  const P = permitidos.length
    ? ` and not ip.src in {${permitidos.join(" ")}}`
    : "";
  const E = excecoesCaminho.length
    ? ` and not (${excecoesCaminho.map(condicaoCaminho).join(" or ")})`
    : "";
  // O próprio Vigia fica fora: no exterior o modo viagem é ativado por ele.
  const H = vigiaHost ? ` and http.host ne "${esc(vigiaHost)}"` : "";
  const expr = `(${origem} and not cf.client.bot${H}${P}${E})`;
  if (expr.length > LIMITE_EXPRESSAO) {
    throw new Error(
      `A expressão do bloqueio estrangeiro ficou com ${expr.length} caracteres e excede o limite de ${LIMITE_EXPRESSAO} do Cloudflare — remova exceções, IPs permitidos ou ASNs de datacenter (${asnsDatacenter.length} na regra)`,
    );
  }
  return expr;
}

/**
 * Regra "Vigia: conector": pula a WAF gerenciada da Cloudflare (bloqueio de bots
 * de IA / Super Bot Fight Mode), o rate-limit e os produtos legados para a faixa
 * do conector no host do Vigia, apenas nos caminhos do conector/admin. É uma
 * regra de `skip` — nunca libera nada além desses caminhos nesse host, e a
 * faixa da Anthropic entra SEMPRE (as faixas extras são aditivas, nunca a
 * substituem). Garante que o conector/admin não leve 403 da borda.
 */
export function regraConector(
  faixasExtra: string[] = [],
  vigiaHost: string = VIGIA_HOST_PADRAO,
  caminhos: string[] = CAMINHOS_CONECTOR,
): RegraCf {
  const faixas = [...new Set([...FAIXA_CONECTOR_PADRAO, ...faixasExtra])];
  for (const f of faixas) {
    if (!ipOuCidrValido(f)) {
      throw new Error(`Faixa do conector inválida: "${f}" (use IPv4/IPv6/CIDR)`);
    }
  }
  const ipCond = `ip.src in {${faixas.join(" ")}}`;
  const hostCond = vigiaHost ? ` and http.host eq "${esc(vigiaHost)}"` : "";
  const pathCond = caminhos.length
    ? ` and (${caminhos.map(condicaoCaminho).join(" or ")})`
    : "";
  return {
    description: DESCRICAO_CONECTOR,
    expression: `(${ipCond}${hostCond}${pathCond})`,
    action: "skip",
    enabled: true,
    action_parameters: {
      ruleset: "current",
      phases: ["http_ratelimit", "http_request_firewall_managed"],
      products: [
        "waf",
        "bic",
        "hot",
        "securityLevel",
        "rateLimit",
        "uaBlock",
        "zoneLockdown",
      ],
    },
  };
}

/**
 * Faixas extras do conector (além da da Anthropic, que é embutida): vendedores
 * buscados (OpenAI/Codex) + decisões do usuário (permanente/temporário vigente).
 */
export async function faixasConectorExtra(sql: Sql): Promise<string[]> {
  return await faixasConectorTabela(sql);
}

/**
 * Garante a regra "Vigia: conector" (skip da WAF gerenciada para o conector) em
 * cada zona. Idempotente e reaplicada a cada subida; nunca lança por zona.
 */
export async function garantirConector(
  deps: ExecutorDeps,
  zonas: string[],
): Promise<{ zonasComFalha: string[] }> {
  const regra = regraConector(
    await faixasConectorExtra(deps.sql),
    deps.cfg.vigiaHost ?? VIGIA_HOST_PADRAO,
  );
  const zonasComFalha: string[] = [];
  for (const z of zonas) {
    try {
      const resultado = await comRetry(
        deps,
        () => garantirRegraZona(deps.api, z, regra),
      );
      if (resultado !== "inalterada") {
        await auditar(deps.sql, "sistema", "conector", z, { resultado });
      }
    } catch (e) {
      const erro = (e as Error).message;
      console.error(`conector: zona ${z} falhou: ${erro}`);
      zonasComFalha.push(z);
      try {
        await auditar(deps.sql, "sistema", "conector", z, { erro });
      } catch (e2) {
        console.error(`conector: auditoria falhou: ${(e2 as Error).message}`);
      }
    }
  }
  return { zonasComFalha };
}

/**
 * Faixas de IA que isentam a regra de geo/datacenter em TODAS as zonas
 * monitoradas (não só no host do Vigia): a da Anthropic (embutida, igual à do
 * conector) + as de vendedores buscados/decididos (OpenAI, Google, ...) em
 * vigia.conector_faixas. Sem isso, "usar Google/GPT/Claude" nos outros apps do
 * usuário levava bloqueio de borda, já que o skip do conector só cobre
 * vigiaHost + caminhos de admin/MCP.
 */
async function faixasIaGeo(sql: Sql): Promise<string[]> {
  return [
    ...new Set([...FAIXA_CONECTOR_PADRAO, ...(await faixasConectorTabela(sql))]),
  ];
}

async function montarExpressao(
  deps: ExecutorDeps,
  extra?: string,
): Promise<string> {
  const { sql } = deps;
  const exc = await sql`
    SELECT valor FROM vigia.excecoes WHERE tipo = 'caminho' ORDER BY id`;
  const per = await sql`
    SELECT regexp_replace(ip::text, '/(32|128)$', '') ip FROM vigia.permitidos
    WHERE expira IS NULL OR expira > ${deps.agora()} ORDER BY id`;
  const ips = per.map((r) => String(r.ip));
  if (extra && !ips.includes(extra)) ips.push(extra);
  const caminhos = exc.map((r) => String(r.valor));
  const vigiaHost = deps.cfg.vigiaHost ?? VIGIA_HOST_PADRAO;
  const asns = await asnsDatacenterAtivos(sql);
  const faixasIa = await faixasIaGeo(sql);
  const todos = [...new Set([...ips, ...faixasIa])];
  try {
    return expressaoGeo(caminhos, todos, vigiaHost, asns);
  } catch (e) {
    // Nunca deixa o crescimento das faixas de IA quebrar o bloqueio geo pra
    // TODAS as zonas: cai pro conjunto sem elas (mantendo exceções e IPs
    // permitidos, que são da própria curadoria do usuário/admin). Se mesmo
    // assim estourar (ex.: excesso de exceções/permitidos), o erro sobe igual
    // a antes.
    console.error(
      `geoblock: expressão com faixas de IA (${faixasIa.length}) falhou, tentando sem elas: ${
        (e as Error).message
      }`,
    );
    return expressaoGeo(caminhos, ips, vigiaHost, asns);
  }
}

/** ASNs de datacenter que entram na regra (vazio se bloquear_datacenter = false). */
export async function asnsDatacenterAtivos(sql: Sql): Promise<number[]> {
  const [c] = await sql`
    SELECT valor FROM vigia.config_geral WHERE chave = 'bloquear_datacenter'`;
  if (c?.valor === false) return [];
  const rows = await sql`
    SELECT asn FROM vigia.asn_datacenter WHERE ativo ORDER BY asn`;
  return rows.map((r) => Number(r.asn));
}

export async function aplicarGeo(
  deps: ExecutorDeps,
  zonas: string[],
  ativo: boolean,
): Promise<{ zonasComFalha: string[] }> {
  const { sql } = deps;
  const expression = await montarExpressao(deps);
  const regra: RegraCf = {
    description: DESCRICAO_GEO,
    expression,
    action: "block",
    enabled: ativo,
  };
  const zonasComFalha: string[] = [];
  for (const z of zonas) {
    try {
      const resultado = await comRetry(
        deps,
        () => garantirRegraZona(deps.api, z, regra),
      );
      if (resultado !== "inalterada") {
        await auditar(sql, "sistema", "geo", z, { resultado, ativo });
      }
    } catch (e) {
      const erro = (e as Error).message;
      console.error(`geoblock: zona ${z} falhou: ${erro}`);
      zonasComFalha.push(z);
      try {
        await auditar(sql, "sistema", "geo", z, { erro, ativo });
      } catch (e2) {
        console.error(`geoblock: auditoria falhou: ${(e2 as Error).message}`);
      }
    }
  }
  // Ativação da regra (base da definição de "passou"): grava só se ainda não
  // houver e se alguma zona aplicou; desligar apaga.
  if (!ativo) {
    await sql`DELETE FROM vigia.config_geral WHERE chave = 'geo_ativo_desde'`;
  } else if (zonas.length > zonasComFalha.length) {
    await sql`INSERT INTO vigia.config_geral (chave, valor)
      VALUES ('geo_ativo_desde', to_jsonb(${deps.agora().toISOString()}::text))
      ON CONFLICT (chave) DO NOTHING`;
  }
  return { zonasComFalha };
}

/** Libera `ip` por `horas` e reaplica a regra mantendo o estado atual (geo_ativo). */
export async function modoViagem(
  deps: ExecutorDeps,
  ip: string,
  horas: number,
  zonas: string[],
): Promise<{ zonasComFalha: string[] }> {
  if (!ipOuCidrValido(ip)) {
    throw new Error(`IP inválido: "${ip}"`);
  }
  if (!(horas > 0) || !Number.isFinite(horas)) {
    throw new Error("Duração do modo viagem deve ser maior que zero horas");
  }
  await montarExpressao(deps, ip); // valida tamanho antes de gravar
  const expira = new Date(deps.agora().getTime() + horas * HORA_MS);
  await deps.sql`
    INSERT INTO vigia.permitidos (ip, expira, nota)
    VALUES (${ip}::inet, ${expira}, 'modo viagem')
    ON CONFLICT (ip) DO UPDATE SET
      expira = CASE WHEN vigia.permitidos.expira IS NULL THEN NULL
        ELSE GREATEST(vigia.permitidos.expira, EXCLUDED.expira) END,
      nota = COALESCE(vigia.permitidos.nota, EXCLUDED.nota)`;
  const [c] = await deps.sql`
    SELECT valor FROM vigia.config_geral WHERE chave = 'geo_ativo'`;
  return aplicarGeo(deps, zonas, c?.valor === true);
}

async function zonasAtivas(sql: Sql): Promise<string[]> {
  const rows =
    await sql`SELECT cf_zone_id FROM vigia.zonas WHERE ativa ORDER BY id`;
  return rows.map((r) => String(r.cf_zone_id));
}

async function marcarAplicado(sql: Sql, agora: Date) {
  await sql`INSERT INTO vigia.config_geral (chave, valor)
    VALUES ('geo_aplicado_em', to_jsonb(${agora.toISOString()}::text))
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
}

/** Reaplica a regra geo nas zonas monitoradas com o estado atual de geo_ativo. */
export async function reaplicarGeoAtual(
  deps: ExecutorDeps,
): Promise<{ zonasComFalha: string[] }> {
  const agora = deps.agora();
  const [c] = await deps.sql`
    SELECT valor FROM vigia.config_geral WHERE chave = 'geo_ativo'`;
  const r = await aplicarGeo(
    deps,
    await zonasAtivas(deps.sql),
    c?.valor === true,
  );
  await marcarAplicado(deps.sql, agora);
  return r;
}

/** modoViagem nas zonas monitoradas, registrando geo_aplicado_em. */
export async function modoViagemAtual(
  deps: ExecutorDeps,
  ip: string,
  horas: number,
): Promise<{ zonasComFalha: string[] }> {
  const agora = deps.agora();
  const r = await modoViagem(deps, ip, horas, await zonasAtivas(deps.sql));
  await marcarAplicado(deps.sql, agora);
  return r;
}
