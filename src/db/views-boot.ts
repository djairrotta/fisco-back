/**
 * Views materializadas que nascem vazias (WITH NO DATA) na migracao e sao
 * preenchidas em segundo plano depois que o servidor sobe.
 *
 * Por que nao no boot, de forma sincrona: preencher a mv_devedor le as 30
 * milhoes de inscricoes. Isso leva minutos, e o healthcheck do container
 * nao espera minutos -- o orquestrador mataria o servidor no meio e
 * entraria em laco. Respondendo 503 com `preparando: true` nas rotas que
 * dependem dela, o resto do sistema (login, notas, kanban) funciona desde
 * o primeiro segundo.
 */
import { pool } from "./pool.js";
import { atualizarViews } from "../etl/refresh-views.js";

/**
 * Carga terminou depois do ultimo recalculo? Entao recalcula agora. Cobre
 * o container que reiniciou entre o fim de uma carga e o recalculo.
 */
export async function recalcularSeDadoNovo(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT (SELECT max(terminou_em) FROM fisco.carga_etl WHERE erro IS NULL)
              > coalesce((SELECT atualizado_em FROM fisco.views_estado WHERE id = 1), '-infinity')
            AS novo`).catch(() => ({ rows: [] as any[] }));
  if (!rows[0]?.novo) return false;
  console.log("[views] ha carga mais nova que o ultimo recalculo; recalculando");
  await atualizarViews();
  prontas.clear();
  return true;
}

const prontas = new Set<string>();
let preenchendo: Promise<void> | null = null;

export async function viewPronta(nome: string): Promise<boolean> {
  if (prontas.has(nome)) return true;
  const { rows } = await pool.query(
    `SELECT ispopulated FROM pg_matviews WHERE schemaname = 'fisco' AND matviewname = $1`, [nome]);
  const ok = rows[0]?.ispopulated === true;
  if (ok) prontas.add(nome);
  return ok;
}

/** Dispara (uma vez) o preenchimento das views vazias. Nao bloqueia. */
export function preencherViewsVazias(nomes = ["mv_devedor", "mv_socio_devedor"]): Promise<void> {
  if (preenchendo) return preenchendo;
  preenchendo = (async () => {
    // Dado corrigido ANTES de montar a view, senao ela nasce com o erro.
    // Se a correcao rodou e a view ja estava pronta, ela e recalculada.
    const corrigiu = await corrigirTributosAntigos().catch(() => false);
    if (corrigiu) await atualizarDependentes();
    for (const nome of nomes) {
      if (await viewPronta(nome).catch(() => true)) continue;
      const cli = await pool.connect();
      const t = Date.now();
      try {
        // SET LOCAL dentro da transacao: nao vaza para o pool.
        await cli.query("BEGIN");
        await cli.query("SET LOCAL statement_timeout = 0");
        await cli.query(`REFRESH MATERIALIZED VIEW fisco.${nome}`);
        await cli.query("COMMIT");
        prontas.add(nome);
        console.log(`[views] ${nome} preenchida em ${Math.round((Date.now() - t) / 1000)}s`);
      } catch (e) {
        await cli.query("ROLLBACK").catch(() => {});
        console.error(`[views] ${nome} falhou ao preencher:`, e instanceof Error ? e.message : e);
      } finally {
        cli.release();
      }
    }
  })().finally(() => { preenchendo = null; });
  return preenchendo;
}

/** Depois de um REFRESH feito por outro caminho (ETL), esquece o estado. */
export function esquecerEstadoViews() { prontas.clear(); }

/**
 * Corrige no lugar o tributo das inscricoes previdenciarias gravadas antes
 * de `tributoDaLinha` existir (todas viraram "Outros"). Roda uma vez: depois
 * da correcao a consulta de checagem nao acha nada e sai na hora. A proxima
 * carga trimestral ja grava certo.
 */
export async function corrigirTributosAntigos(): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM fisco.divida_inscricao
      WHERE origem = 'PGFN_PREV' AND tributo <> 'Contribuição Previdenciária' LIMIT 1`);
  if (!rows.length) return false;
  const cli = await pool.connect();
  const t = Date.now();
  try {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL statement_timeout = 0");
    await cli.query("SET LOCAL lock_timeout = '30s'");
    const r = await cli.query(
      `UPDATE fisco.divida_inscricao SET tributo = 'Contribuição Previdenciária'
        WHERE origem = 'PGFN_PREV' AND tributo <> 'Contribuição Previdenciária'`);
    await cli.query(
      `UPDATE fisco.divida_inscricao SET tributo = 'FGTS'
        WHERE origem = 'PGFN_FGTS' AND tributo <> 'FGTS'`);
    await cli.query("COMMIT");
    console.log(`[dados] tributo previdenciario corrigido em ${r.rowCount} inscricoes (${Math.round((Date.now() - t) / 1000)}s)`);
    return true;
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    console.error("[dados] correcao de tributo falhou:", e instanceof Error ? e.message : e);
    return false;
  } finally { cli.release(); }
}

/** Recalcula as views que leem o tributo, depois de uma correcao de dado. */
async function atualizarDependentes() {
  for (const v of ["mv_divida_empresa", "mv_municipio_tributo", "mv_devedor"]) {
    const { rows } = await pool.query(
      `SELECT ispopulated FROM pg_matviews WHERE schemaname = 'fisco' AND matviewname = $1`, [v]);
    if (!rows[0]?.ispopulated) continue;   // a vazia sera preenchida logo abaixo
    const cli = await pool.connect();
    try {
      await cli.query("BEGIN");
      await cli.query("SET LOCAL statement_timeout = 0");
      await cli.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY fisco.${v}`);
      await cli.query("COMMIT");
    } catch (e) {
      await cli.query("ROLLBACK").catch(() => {});
      console.error(`[views] ${v} nao atualizou apos correcao:`, e instanceof Error ? e.message : e);
    } finally { cli.release(); }
  }
}
