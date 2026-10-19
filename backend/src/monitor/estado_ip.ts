// Vigia 1.1 (G/I): estado de cada IP para as telas — bloqueio ativo do Vigia e
// o que a regra "Vigia: fora do Brasil" fez com ele. Uma consulta para a lista toda.
import type { Sql } from "../db/client.ts";
import {
  ACOES_BARRADAS,
  DESCRICAO_GEO,
  MOTIVO_PASSOU,
  padroesLike,
} from "./estrangeiro.ts";

export interface EstadoIp {
  ip: string;
  /** Há linha ativa em vigia.bloqueios (não removida e não vencida). */
  bloqueado: boolean;
  /** Vencimento do bloqueio ativo (null: sem bloqueio ou sem validade). */
  bloqueadoAte: string | null;
  /** Só para IP estrangeiro (eventos dos últimos 7 dias). */
  geo: {
    /** Requisições barradas pela regra Fora do Brasil (block/managed_challenge). */
    barrados: number;
    /** Requisições estrangeiras que chegaram à origem. */
    passou: number;
    passaram: { caminho: string; motivo: string }[];
  } | null;
  /** Localização aproximada do cache (vigia.ip_local); nunca consulta o provedor. */
  local: LocalCache | null;
}

export interface LocalCache {
  cidade: string | null;
  regiao: string | null;
  pais: string | null;
  provedor: string | null;
  asn: number | null;
}

const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
function localDe(d: unknown): LocalCache | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  const l: LocalCache = {
    cidade: txt(o.cidade),
    regiao: txt(o.regiao),
    pais: txt(o.pais),
    provedor: txt(o.provedor),
    asn: typeof o.asn === "number" && Number.isFinite(o.asn) ? o.asn : null,
  };
  return Object.values(l).some((v) => v !== null) ? l : null;
}

const JANELA_MS = 7 * 86_400_000;

/** Contexto da definição única de "passou" (permitidos e bots vêm do banco). */
export interface CtxEstado {
  excecoes: string[];
  vigiaHost: string;
  /** Ativação da regra geo (null: regra desligada → nada "passou"). */
  geoAtivoDesde: Date | null;
}

/** Mapa indexado pelo IP de ENTRADA (ex.: "::ffff:1.2.3.4" fica como veio). */
export async function estadoIps(
  sql: Sql,
  ips: string[],
  agora: Date,
  ctx: CtxEstado,
): Promise<Map<string, EstadoIp>> {
  const unicos = [...new Set(ips)];
  const out = new Map<string, EstadoIp>();
  if (unicos.length === 0) return out;
  const desde = new Date(agora.getTime() - JANELA_MS);
  // "passou": mesma definição de estrangeiro.ts/passouGeo, em SQL.
  const rows = await sql`
    WITH entrada AS (
      SELECT DISTINCT t AS entrada, t::inet AS ip FROM unnest(${unicos}::text[]) t),
    alvo AS (SELECT DISTINCT ip FROM entrada),
    b AS (
      SELECT ip, bool_or(expira IS NULL) sem_validade, max(expira) ate
      FROM vigia.bloqueios
      WHERE removido IS NULL AND (expira IS NULL OR expira > ${agora})
        AND ip IN (SELECT ip FROM alvo)
      GROUP BY ip),
    ev AS (
      SELECT e.*, (e.fonte = 'http' AND e.pais <> '' AND upper(e.pais) <> 'BR'
        AND ${ctx.geoAtivoDesde}::timestamptz IS NOT NULL
        AND e.ts >= ${ctx.geoAtivoDesde}::timestamptz
        AND ((e.status BETWEEN 200 AND 399) OR e.status = 404)
        AND lower(coalesce(e.host, '')) <> lower(${ctx.vigiaHost})
        AND NOT (split_part(e.caminho, '?', 1) LIKE ANY(${
    padroesLike(ctx.excecoes)
  }::text[]))
        AND NOT EXISTS (SELECT 1 FROM vigia.permitidos p
          WHERE (p.expira IS NULL OR p.expira > ${agora}) AND e.ip <<= p.ip)
        AND NOT EXISTS (SELECT 1 FROM vigia.bots_verificados bv
          WHERE bv.ip = e.ip)) AS passou
      FROM vigia.eventos e
      WHERE e.ip IN (SELECT ip FROM alvo) AND e.ts >= ${desde}),
    g AS (
      SELECT ip,
        coalesce(sum(contagem) FILTER (WHERE fonte = 'firewall'
          AND regra_cf = ${DESCRICAO_GEO}
          AND lower(acao_cf) = ANY(${ACOES_BARRADAS}::text[])), 0)::int barrados,
        coalesce(sum(contagem) FILTER (WHERE passou), 0)::int passou,
        (array_agg(DISTINCT caminho) FILTER (WHERE passou))[1:5] caminhos,
        bool_or(pais <> '' AND upper(pais) <> 'BR') estrangeiro
      FROM ev GROUP BY ip)
    SELECT entrada.entrada, b.ate, b.sem_validade, g.barrados, g.passou,
      g.caminhos, g.estrangeiro, l.dados AS local
    FROM entrada LEFT JOIN b USING (ip) LEFT JOIN g USING (ip)
      LEFT JOIN vigia.ip_local l USING (ip)`;
  for (const r of rows) {
    const bloqueado = r.ate !== null || r.sem_validade === true;
    const ip = String(r.entrada);
    out.set(ip, {
      ip,
      bloqueado,
      bloqueadoAte: r.sem_validade || !r.ate
        ? null
        : new Date(r.ate).toISOString(),
      geo: r.estrangeiro
        ? {
          barrados: Number(r.barrados),
          passou: Number(r.passou),
          passaram: ((r.caminhos ?? []) as string[]).map((c) => ({
            caminho: c,
            motivo: MOTIVO_PASSOU,
          })),
        }
        : null,
      local: localDe(r.local),
    });
  }
  return out;
}
