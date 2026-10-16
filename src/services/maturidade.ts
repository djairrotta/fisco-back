/**
 * Maturidade jurisprudencial via Hermes (jurisprudencia.judinfo.com.br).
 * Roda semanalmente. Tese que virou contra sai do mapa sozinha.
 */
import { request } from "undici";
import { env } from "../lib/env.js";
import { q } from "../db/pool.js";

type Maturidade = "consolidada_favoravel" | "em_disputa" | "modulada" | "derrotada";

export async function reconsultarTeses() {
  const teses = await q<{ slug: string; maturidade: Maturidade; temas: any; processos: any }>(
    `SELECT slug, maturidade, temas, processos FROM tese WHERE ativa`
  );
  for (const t of teses) {
    const ids = [...(t.temas ?? []), ...(t.processos ?? [])];
    if (!ids.length) continue;
    try {
      const r = await request(`${env.HERMES_BASE_URL}/status-tese`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identificadores: ids }),
      });
      if (r.statusCode !== 200) continue;
      const d: any = await r.body.json();
      const nova: Maturidade | undefined = d?.maturidade;
      if (!nova || nova === t.maturidade) {
        await q(`UPDATE tese SET verificada_em = now() WHERE slug = $1`, [t.slug]);
        continue;
      }
      await q(
        `UPDATE tese SET maturidade = $2, verificada_em = now(), atualizada_em = now()
          WHERE slug = $1`,
        [t.slug, nova]
      );
      await q(
        `INSERT INTO tese_historico_maturidade (tese_slug, de, para, motivo, fonte)
         VALUES ($1,$2,$3,$4,'hermes')`,
        [t.slug, t.maturidade, nova, d?.motivo ?? null]
      );
      // Derrotada precisa sair do mapa imediatamente.
      if (nova === "derrotada") {
        await q(`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_divida_empresa`);
      }
    } catch { /* best effort: uma tese que falhou nao derruba o lote */ }
  }
}
