import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { pool } from "./pool.js";

/**
 * Aplica as migracoes no boot.
 *
 * NAO E FATAL de proposito: se a migracao falhar, o servidor ainda sobe e
 * /health responde com o aviso. Derrubar o processo aqui poe o container
 * em laco de reinicio e tira do ar ate o que estava funcionando.
 * O SQL e idempotente e isso foi VERIFICADO: migrate.js roda tres vezes
 * seguidas sobre o mesmo banco sem erro. Se adicionar SQL novo, repita
 * o teste -- um CREATE TYPE cru passa na primeira vez e quebra na segunda.
 */
export async function migrarNoBoot(): Promise<{ ok: boolean; erro?: string }> {
  const cli = await pool.connect();
  let atual = "";
  try {
    // lock_timeout E OBRIGATORIO. Com o agendador no mesmo processo, uma
    // carga da PGFN em andamento segura lock na divida_inscricao; sem
    // timeout a migracao de boot espera PARA SEMPRE, o servidor nunca
    // chega no listen, o healthcheck falha e o orquestrador reverte o
    // deploy. Observado: o COPY do ETL bloqueando duas migracoes por
    // tempo indeterminado. Com o timeout a migracao desiste, o servidor
    // sobe e /health informa que a migracao nao foi aplicada, que e a
    // verdade e e acionavel.
    await cli.query("SET lock_timeout = '20s'");
    await cli.query("SET statement_timeout = '180s'");

    const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sql");
    const arquivos = (await readdir(raiz)).filter((f) => f.endsWith(".sql")).sort();
    // Arquivo ja aplicado com o MESMO conteudo nao roda de novo. Rodar tudo
    // a cada boot pedia lock nas tabelas grandes (CREATE INDEX IF NOT EXISTS
    // pega lock antes de ver que o indice existe) e, durante uma carga de
    // horas, a migracao inteira ficava pendente. MIGRAR_TUDO=1 forca.
    await cli.query(`CREATE SCHEMA IF NOT EXISTS fisco`);
    await cli.query(`CREATE TABLE IF NOT EXISTS fisco.migracao_aplicada (
      arquivo text PRIMARY KEY, hash text NOT NULL, aplicada_em timestamptz NOT NULL DEFAULT now())`);
    const feitas = new Map((await cli.query(`SELECT arquivo, hash FROM fisco.migracao_aplicada`)).rows.map((r: any) => [r.arquivo, r.hash]));
    const forcar = /^(1|true|sim)$/i.test(process.env.MIGRAR_TUDO ?? "");
    const falhas: string[] = [];
    let rodadas = 0;
    for (const f of arquivos) {
      atual = f;
      const sql = await readFile(join(raiz, f), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex").slice(0, 32);
      if (!forcar && feitas.get(f) === hash) continue;
      try {
        await cli.query(sql);
        await cli.query(`INSERT INTO fisco.migracao_aplicada (arquivo, hash) VALUES ($1, $2)
                         ON CONFLICT (arquivo) DO UPDATE SET hash = EXCLUDED.hash, aplicada_em = now()`, [f, hash]);
        rodadas++;
      } catch (e) {
        // Lock ocupado (carga em andamento): segue para os proximos arquivos
        // e este fica para a proxima tentativa. Outro erro: para aqui, porque
        // os arquivos seguintes podem depender deste.
        if (/lock timeout/i.test(String(e))) { falhas.push(f); continue; }
        throw e;
      }
    }
    if (falhas.length) throw new Error(`lock timeout em ${falhas.join(", ")} (os demais foram aplicados)`);
    console.log(`[boot] ${rodadas} de ${arquivos.length} migracoes aplicadas (as outras ja estavam)`);
    return { ok: true };
  } catch (e) {
    let erro = `${atual}: ${e instanceof Error ? e.message : String(e)}`;
    // Quem estava segurando o banco. Sem log centralizado, isto em /health e
    // a unica forma de ver o bloqueio. Literais trocados por ? (sem dado).
    if (/lock timeout/i.test(erro)) {
      const b = await pool.query(
        `SELECT pid, state, wait_event_type, round(extract(epoch FROM now() - xact_start)) AS seg,
                left(regexp_replace(query, $$'[^']*'$$, '?', 'g'), 90) AS sql
           FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state <> 'idle' AND xact_start IS NOT NULL
          ORDER BY xact_start LIMIT 4`).catch(() => ({ rows: [] as any[] }));
      if (b.rows.length) erro += " | ativos: " + b.rows.map((r: any) => `${r.pid} ${r.state} ${r.seg}s ${r.wait_event_type ?? ""} ${r.sql}`).join(" ; ");
    }
    console.error("[boot] migracao falhou:", erro);
    return { ok: false, erro };
  } finally {
    // SET PERSISTE NA CONEXAO. Sem resetar, a conexao volta para o pool
    // carregando statement_timeout=180s, e o PROXIMO que a pegar herda o
    // limite -- foi assim que o COPY do ETL morreu em producao com
    // "canceling statement due to statement timeout" depois de baixar
    // 83 MB. Estado de sessao nao pode vazar entre usuarios do pool.
    await cli.query("RESET statement_timeout").catch(() => {});
    await cli.query("RESET lock_timeout").catch(() => {});
    cli.release();
  }
}

/** Carrega as regras de tese (JSON = fonte unica). Tambem nao fatal. */
export async function carregarTeses(): Promise<number> {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "teses");
    const arquivos = (await readdir(dir)).filter((x) => x.endsWith(".json"));
    for (const f of arquivos) {
      const t = JSON.parse(await readFile(join(dir, f), "utf8"));
      await pool.query(
        `INSERT INTO tese (slug, versao, nome, tributo, fundamento_legal, maturidade,
                           temas, processos, cnae_incluidos, cnae_excluidos, regimes,
                           portes, ufs, exige_divida, tributos_divida, prescricao_meses,
                           formula_estimativa, peso, modelo_peca, checklist_docs, ativa)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (slug) DO UPDATE SET
           versao = EXCLUDED.versao, nome = EXCLUDED.nome,
           maturidade = EXCLUDED.maturidade, temas = EXCLUDED.temas,
           processos = EXCLUDED.processos, peso = EXCLUDED.peso,
           ativa = EXCLUDED.ativa, atualizada_em = now()`,
        [t.slug, t.versao ?? 1, t.nome, t.tributo, t.fundamento_legal, t.maturidade,
         JSON.stringify(t.temas ?? []), JSON.stringify(t.processos ?? []),
         t.cnae_incluidos ?? null, t.cnae_excluidos ?? null, t.regimes ?? null,
         t.portes ?? null, t.ufs ?? null, t.exige_divida ?? false,
         t.tributos_divida ?? null, t.prescricao_meses ?? 60,
         t.formula_estimativa ? JSON.stringify(t.formula_estimativa) : null,
         t.peso ?? 1.0, t.modelo_peca ?? null, t.checklist_docs ?? null, t.ativa ?? true]
      );
    }
    console.log(`[boot] ${arquivos.length} teses carregadas`);
    return arquivos.length;
  } catch (e) {
    console.error("[boot] carga de teses falhou:", e);
    return 0;
  }
}
