/** Carrega as regras de tese (JSON = fonte unica) para o banco. */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool } from "../db/pool.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "teses");
for (const f of (await readdir(dir)).filter(x => x.endsWith(".json"))) {
  const t = JSON.parse(await readFile(join(dir, f), "utf8"));
  await q(
    `INSERT INTO tese (slug, versao, nome, tributo, fundamento_legal, maturidade,
                       temas, processos, cnae_incluidos, cnae_excluidos, regimes,
                       portes, ufs, exige_divida, tributos_divida, prescricao_meses,
                       formula_estimativa, peso, modelo_peca, checklist_docs, ativa)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (slug) DO UPDATE SET
       versao = EXCLUDED.versao, nome = EXCLUDED.nome, maturidade = EXCLUDED.maturidade,
       temas = EXCLUDED.temas, processos = EXCLUDED.processos, peso = EXCLUDED.peso,
       ativa = EXCLUDED.ativa, atualizada_em = now()`,
    [t.slug, t.versao ?? 1, t.nome, t.tributo, t.fundamento_legal, t.maturidade,
     JSON.stringify(t.temas ?? []), JSON.stringify(t.processos ?? []),
     t.cnae_incluidos ?? null, t.cnae_excluidos ?? null, t.regimes ?? null,
     t.portes ?? null, t.ufs ?? null, t.exige_divida ?? false,
     t.tributos_divida ?? null, t.prescricao_meses ?? 60,
     t.formula_estimativa ? JSON.stringify(t.formula_estimativa) : null,
     t.peso ?? 1.0, t.modelo_peca ?? null, t.checklist_docs ?? null, t.ativa ?? true]
  );
  console.log(`tese carregada: ${t.slug} (${t.maturidade})`);
}
await pool.end();
