import type { CfApi } from "./client.ts";
import type { Sql } from "../db/client.ts";

const POR_PAGINA = 50;
const MAX_PAGINAS = 100;

/** Copia as zonas da conta para vigia.zonas: novas entram ativas; nada é apagado. */
export async function sincronizarZonas(
  api: CfApi,
  sql: Sql,
): Promise<{ total: number; novas: number }> {
  const zonas: { id: string; name: string }[] = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    const r = await api.rest<{ id: string; name: string }[]>(
      "GET",
      `/zones?per_page=${POR_PAGINA}&page=${page}`,
    );
    zonas.push(...(r ?? []));
    if (!r || r.length < POR_PAGINA) break;
  }
  let novas = 0;
  for (const z of zonas) {
    const ins = await sql`INSERT INTO vigia.zonas (nome, cf_zone_id, ativa)
      VALUES (${z.name}, ${z.id}, true)
      ON CONFLICT (cf_zone_id) DO NOTHING RETURNING id`;
    novas += ins.length;
  }
  return { total: zonas.length, novas };
}

/** cf_zone_id das zonas monitoradas (ativa = true). */
export async function zonasMonitoradas(sql: Sql): Promise<string[]> {
  const rows =
    await sql`SELECT cf_zone_id FROM vigia.zonas WHERE ativa ORDER BY id`;
  return rows.map((r) => String(r.cf_zone_id));
}
