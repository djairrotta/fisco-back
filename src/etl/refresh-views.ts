/**
 * Recalcula as views materializadas na ordem de dependencia.
 *
 * CONCURRENTLY exige indice unico e um primeiro refresh normal; por isso
 * a primeira execucao de cada view e sem CONCURRENTLY e as seguintes com,
 * para nao travar leitura do painel durante a atualizacao.
 *
 * View AUSENTE nao derruba as outras. A versao anterior desestruturava o
 * resultado da consulta direto ([{ preenchida }]) e estourava com
 * "Cannot read properties of undefined" quando uma view nao existia --
 * uma unica view faltando cancelava a atualizacao das outras quatro, que
 * e exatamente o oposto do que se quer numa rotina de manutencao.
 */
import { pool } from "../db/pool.js";

const VIEWS = ["mv_divida_empresa", "mv_divida_pessoa", "mv_municipio",
               "mv_municipio_tributo", "mv_uf", "mv_socio_devedor", "mv_devedor"];

export async function atualizarViews() {
  const ausentes: string[] = [];
  const falharam: string[] = [];

  for (const v of VIEWS) {
    const { rows } = await pool.query<{ preenchida: boolean }>(
      `SELECT ispopulated AS preenchida FROM pg_matviews
        WHERE schemaname = 'fisco' AND matviewname = $1`, [v]
    );
    if (rows.length === 0) {
      console.warn(`[views] ${v} nao existe, pulando`);
      ausentes.push(v);
      continue;
    }
    const modo = rows[0].preenchida ? "CONCURRENTLY " : "";
    const t = Date.now();
    try {
      await pool.query(`REFRESH MATERIALIZED VIEW ${modo}fisco.${v}`);
      console.log(`[views] ${v} em ${Date.now() - t}ms${modo ? " (concorrente)" : ""}`);
    } catch (e) {
      // Uma view quebrada nao pode impedir as demais de atualizar.
      console.error(`[views] ${v} falhou:`, e instanceof Error ? e.message : e);
      falharam.push(v);
    }
  }

  // Marca o recalculo, mesmo parcial: o boot so refaz quando houver carga
  // terminada DEPOIS desta marca.
  await pool.query(`UPDATE fisco.views_estado SET atualizado_em = now() WHERE id = 1`).catch(() => {});

  if (ausentes.length || falharam.length) {
    console.warn(`[views] resumo: ${ausentes.length} ausentes, ${falharam.length} com erro`);
  }
  return { ausentes, falharam };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await atualizarViews();
  await pool.end();
  if (r.falharam.length) process.exit(1);
}
