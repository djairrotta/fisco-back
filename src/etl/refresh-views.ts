import { q, pool } from "../db/pool.js";

// CONCURRENTLY exige indice unico em cada view — ja criado em 004_views.sql.
// Sem isto, o painel fica indisponivel durante o refresh.
const VIEWS = ["mv_divida_empresa", "mv_municipio", "mv_municipio_tributo", "mv_uf"];

for (const v of VIEWS) {
  const t0 = Date.now();
  await q(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${v}`);
  console.log(`${v}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
await pool.end();
