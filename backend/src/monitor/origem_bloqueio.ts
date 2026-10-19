// Vigia 1.2: quem criou cada bloqueio (Jev automático, reserva ou Djair manual)
// e a duração escolhida, derivados da auditoria (ator + detalhes.dias) — sem migração.
import type { Sql } from "../db/client.ts";
import { normalizarIp } from "./grouper.ts";

export type Origem = "jev" | "reserva" | "djair" | "api" | "sistema";

/** Rótulo da tela Bloqueios. */
export const ROTULO_ORIGEM: Record<Origem, string> = {
  jev: "Jev automático",
  reserva: "reserva",
  djair: "Djair manual",
  api: "API (token)",
  sistema: "sistema",
};

/** Rótulo curto do push ("Já estava bloqueado até … (Jev)"). */
export const ROTULO_CURTO: Record<Origem, string> = {
  jev: "Jev",
  reserva: "reserva",
  djair: "Djair",
  api: "API",
  sistema: "sistema",
};

/**
 * Ator gravado na auditoria do bloqueio → origem. "ia:jev"/"ia:reserva" (1.2);
 * "ia" (1.1) pelo motivo: a regra do Jev sempre começa com "Jev".
 */
export function origemDe(ator: string | null, motivo: string | null): Origem {
  const a = (ator ?? "").toLowerCase();
  if (a === "ia:jev") return "jev";
  if (a === "ia:reserva") return "reserva";
  if (a === "ia") return (motivo ?? "").startsWith("Jev") ? "jev" : "reserva";
  if (a === "usuario" || a === "djair") return "djair";
  if (a.startsWith("token:") || a.startsWith("oauth:")) return "api";
  return "sistema";
}

const DIA_MS = 86_400_000;

/** 1 → "24 h"; demais → "N dias". */
export const rotuloDuracao = (dias: number) =>
  dias === 1 ? "24 h" : `${dias} dias`;

/** Duração escolhida: a da auditoria; sem ela, a diferença criado → expira. */
export function diasDe(
  diasAuditoria: unknown,
  criado: Date,
  expira: Date | null,
): number | null {
  const n = Number(diasAuditoria);
  if (Number.isFinite(n) && n > 0) return n;
  if (!expira) return null;
  return Math.max(
    1,
    Math.round((expira.getTime() - criado.getTime()) / DIA_MS),
  );
}

export interface InfoBloqueio {
  id: number;
  ip: string;
  criado: Date;
  expira: Date | null;
  origem: Origem;
  dias: number | null;
}

/** Linhas de vigia.bloqueios com origem e duração (uma passada na auditoria). */
export async function infoBloqueios(
  sql: Sql,
  ids: number[],
): Promise<Map<number, InfoBloqueio>> {
  const out = new Map<number, InfoBloqueio>();
  if (ids.length === 0) return out;
  const rows = await sql`
    WITH b AS (
      SELECT id, host(ip) ip, motivo, criado, expira FROM vigia.bloqueios
      WHERE id = ANY(${ids}::bigint[])),
    a AS (
      SELECT DISTINCT ON ((detalhes->>'bloqueioId'))
        (detalhes->>'bloqueioId') bid, ator, detalhes->>'dias' dias
      FROM vigia.auditoria
      WHERE acao = 'bloquear'
        AND detalhes->>'bloqueioId' = ANY(${ids.map(String)}::text[])
      ORDER BY (detalhes->>'bloqueioId'), id)
    SELECT b.*, a.ator, a.dias FROM b LEFT JOIN a ON a.bid = b.id::text`;
  for (const r of rows) {
    const criado = new Date(r.criado);
    const expira = r.expira ? new Date(r.expira) : null;
    out.set(Number(r.id), {
      id: Number(r.id),
      ip: String(r.ip),
      criado,
      expira,
      origem: origemDe(r.ator ?? null, r.motivo ?? null),
      dias: diasDe(r.dias, criado, expira),
    });
  }
  return out;
}

/** Bloqueios vigentes dos IPs (chave: IP normalizado). */
export async function bloqueiosAtivos(
  sql: Sql,
  ips: string[],
  agora: Date,
): Promise<Map<string, InfoBloqueio>> {
  const out = new Map<string, InfoBloqueio>();
  if (ips.length === 0) return out;
  const norm = [...new Set(ips.map(normalizarIp))];
  const rows = await sql`SELECT id FROM vigia.bloqueios
    WHERE removido IS NULL AND (expira IS NULL OR expira > ${agora})
      AND ip = ANY(${norm}::inet[])`;
  const info = await infoBloqueios(sql, rows.map((r) => Number(r.id)));
  for (const b of info.values()) out.set(normalizarIp(b.ip), b);
  return out;
}
