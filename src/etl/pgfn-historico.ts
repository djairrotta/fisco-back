/**
 * Carga da SERIE HISTORICA da PGFN: todos os trimestres publicados desde
 * 2020, um por vez, do mais antigo para o mais novo.
 *
 * Por que separado da carga principal: a principal SUBSTITUI a posicao
 * atual (divida_inscricao). Esta ACUMULA: para cada trimestre grava o
 * resumo por empresa (divida_trimestre) e atualiza o ciclo de vida de cada
 * inscricao (divida_historico). Com isso a ficha mostra a evolucao e a
 * pesquisa acha "inscricao nova no ultimo trimestre", "parcelamento
 * rescindido agora", "divida que cresceu".
 *
 * Ordem importa: a mudanca de situacao (situacao_anterior/mudou_ref) e
 * calculada comparando com a ultima situacao conhecida, entao cada base e
 * processada em ordem cronologica. Um trimestre que falha para a fila
 * daquela base ate a proxima tentativa -- pular deixaria a mudanca de
 * situacao atribuida ao trimestre errado.
 *
 * Volume e cuidado com o servidor: so PJ e so devedor principal entram no
 * stage (a base nao previdenciaria tem ~45 milhoes de linhas; PJ principal
 * e uma fracao). Nada de DELETE gigante: o stage e temporario e o resumo
 * entra por UPSERT.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import copy from "pg-copy-streams";
import { pool, q } from "../db/pool.js";
import { BASES, lerCabecalho, type Mapa, type Origem } from "./pgfn.js";

const RAIZ = "https://dadosabertos.pgfn.gov.br";
const DESDE = process.env.PGFN_HISTORICO_DESDE || "2020_trimestre_01";

/** "2021_trimestre_03" -> "2021-09-30" */
export function dataRefDoPeriodo(periodo: string): string {
  const m = /^(\d{4})_trimestre_0([1-4])$/.exec(periodo);
  if (!m) throw new Error(`periodo invalido: ${periodo}`);
  const fim = ["03-31", "06-30", "09-30", "12-31"][Number(m[2]) - 1];
  return `${m[1]}-${fim}`;
}

/** Trimestres publicados, do mais antigo ao mais novo, a partir de DESDE. */
export async function periodosPublicados(): Promise<string[]> {
  const r = await fetch(RAIZ + "/", { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`listagem da PGFN falhou: ${r.status}`);
  const html = await r.text();
  return [...new Set(html.match(/20\d\d_trimestre_0[1-4]/g) ?? [])].sort()
    .filter((p) => p >= DESDE);
}

/** Garante uma linha de controle por trimestre x base. */
export async function sincronizarFila() {
  const periodos = await periodosPublicados();
  for (const p of periodos) {
    for (const o of Object.keys(BASES)) {
      await q(`INSERT INTO fisco.pgfn_hist_carga (periodo, origem, data_ref) VALUES ($1,$2,$3)
               ON CONFLICT DO NOTHING`, [p, o, dataRefDoPeriodo(p)]);
    }
  }
  return periodos.length;
}

const dataIso = (d: string) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((d || "").trim());
  if (!m || Number(m[3]) < 1900) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
};
const csv = (v: string) => (v === "" ? "" : /[";\n,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Linha do CSV -> linha do stage, ou null (PF, corresponsavel, invalida).
 * Exportada para teste.
 */
export function linhaHistorico(linha: string, mapa: Mapa): string | null {
  const p = linha.split(";");
  const v = (n: string) => { const i = mapa[n]; return i === undefined ? "" : (p[i] ?? "").trim(); };
  if (!/principal/i.test(v("TIPO_DEVEDOR"))) return null;
  const bruto = v("CPF_CNPJ");
  if (bruto.includes("*") || /^X{3}/i.test(bruto)) return null;           // CPF mascarado
  const rot = v("TIPO_PESSOA");
  if (/f[ií]s/i.test(rot)) return null;
  const doc = bruto.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(doc)) return null;
  const numero = v("NUMERO_INSCRICAO");
  if (!numero) return null;
  const valor = Number(v("VALOR_CONSOLIDADO").replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(valor)) return null;
  return [
    numero, doc.slice(0, 8), v("UF_DEVEDOR").toUpperCase().slice(0, 2),
    v("RECEITA_PRINCIPAL") || v("TIPO_CREDITO"), dataIso(v("DATA_INSCRICAO")),
    String(valor), v("SITUACAO_INSCRICAO"),
    /^sim$/i.test(v("INDICADOR_AJUIZADO")) ? "true" : "false",
  ].map(csv).join(";") + "\n";
}

/** Situacao de acordo em curso / acordo que caiu (mesmas regras da triagem de programas). */
const SQL_NEGOCIADA = `(situacao !~* 'RESCIND|RESCISAO' AND situacao ~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI|PENHORA REGULAR E SUFICIENTE')`;
const SQL_RESCINDIDA = `(situacao ~* 'RESCIND|RESCISAO')`;

/** Processa um trimestre de uma base. */
export async function carregarTrimestre(periodo: string, origem: Origem) {
  const dataRef = dataRefDoPeriodo(periodo);
  const dir = await mkdtemp(join(tmpdir(), "pgfnh-"));
  const zipLocal = join(dir, "base.zip");
  const cli = await pool.connect();
  let linhas = 0, aceitas = 0;
  try {
    await cli.query(`UPDATE fisco.pgfn_hist_carga SET status='carregando', comecou_em=now(), erro=NULL
                      WHERE periodo=$1 AND origem=$2`, [periodo, origem]);
    const r = await fetch(`${RAIZ}/${periodo}/${BASES[origem]}`);
    if (!r.ok || !r.body) throw new Error(`download falhou: ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as any), createWriteStream(zipLocal));

    // SET LOCAL antes do COPY (ver pgfn.ts: depois do COPY trava a conexao).
    await cli.query("BEGIN");
    await cli.query("SET LOCAL statement_timeout = 0");
    await cli.query("SET LOCAL lock_timeout = '2min'");
    await cli.query("SET LOCAL work_mem = '256MB'");
    await cli.query(`CREATE TEMP TABLE stage_hist (
        numero text, raiz char(8), uf char(2), receita text, data_inscricao date,
        valor numeric(18,2), situacao text, ajuizado boolean) ON COMMIT DROP`);
    const destino = cli.query(copy.from(
      `COPY stage_hist FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`) as never) as unknown as Writable;
    let erroCopy: Error | null = null;
    destino.on("error", (e: Error) => { erroCopy = e; });

    const zip = await unzipper.Open.file(zipLocal);
    for (const e of zip.files) {
      if (e.type !== "File" || !e.path.toLowerCase().endsWith(".csv")) continue;
      const rl = createInterface({ input: e.stream().setEncoding("latin1") as unknown as Readable, crlfDelay: Infinity });
      let mapa: Mapa | null = null;
      let buf: string[] = [];
      for await (const l of rl) {
        if (!mapa) { mapa = lerCabecalho(l); continue; }
        linhas++;
        const s = linhaHistorico(l, mapa);
        if (!s) continue;
        aceitas++;
        buf.push(s);
        if (buf.length >= 5000) {
          const bloco = buf.join(""); buf = [];
          if (!destino.write(bloco)) await new Promise<void>((ok) => destino.once("drain", () => ok()));
        }
        if (erroCopy) throw erroCopy;
      }
      if (buf.length) destino.write(buf.join(""));
    }
    destino.end();
    await new Promise<void>((ok, erro) => {
      if (erroCopy) return erro(erroCopy);
      destino.on("finish", () => ok()); destino.on("error", erro);
    });

    // Duplicata de numero no mesmo trimestre (acontece: a mesma inscricao em
    // dois arquivos do zip) faria o UPSERT falhar com "cannot affect row a
    // second time". Fica a de maior valor.
    await cli.query(`CREATE TEMP TABLE stage_u ON COMMIT DROP AS
        SELECT DISTINCT ON (numero) * FROM stage_hist ORDER BY numero, valor DESC NULLS LAST`);

    await cli.query(`
      INSERT INTO fisco.divida_trimestre AS t
        (cnpj_raiz, data_ref, origem, qtd, valor, qtd_ajuizada, valor_ajuizado, qtd_negociada, qtd_rescindida)
      SELECT raiz, $1::date, $2, count(*), coalesce(sum(valor),0),
             count(*) FILTER (WHERE ajuizado), coalesce(sum(valor) FILTER (WHERE ajuizado),0),
             count(*) FILTER (WHERE ${SQL_NEGOCIADA}), count(*) FILTER (WHERE ${SQL_RESCINDIDA})
        FROM stage_u GROUP BY raiz
      ON CONFLICT (cnpj_raiz, data_ref, origem) DO UPDATE SET
        qtd = EXCLUDED.qtd, valor = EXCLUDED.valor, qtd_ajuizada = EXCLUDED.qtd_ajuizada,
        valor_ajuizado = EXCLUDED.valor_ajuizado, qtd_negociada = EXCLUDED.qtd_negociada,
        qtd_rescindida = EXCLUDED.qtd_rescindida`, [dataRef, origem]);

    // Ciclo de vida. Processado em ordem cronologica: quando a situacao
    // muda em relacao a ultima vista, guarda a anterior e o trimestre.
    await cli.query(`
      INSERT INTO fisco.divida_historico AS h
        (origem, numero_inscricao, cnpj_raiz, uf, receita, data_inscricao,
         primeiro_ref, ultimo_ref, valor_primeiro, valor_ultimo,
         situacao_primeira, situacao_ultima, ajuizado_ultimo)
      SELECT $2, numero, raiz, uf, receita, data_inscricao,
             $1::date, $1::date, valor, valor, situacao, situacao, ajuizado
        FROM stage_u
      ON CONFLICT (origem, numero_inscricao) DO UPDATE SET
        primeiro_ref     = LEAST(h.primeiro_ref, EXCLUDED.primeiro_ref),
        valor_primeiro   = CASE WHEN EXCLUDED.primeiro_ref < h.primeiro_ref THEN EXCLUDED.valor_primeiro ELSE h.valor_primeiro END,
        situacao_primeira= CASE WHEN EXCLUDED.primeiro_ref < h.primeiro_ref THEN EXCLUDED.situacao_primeira ELSE h.situacao_primeira END,
        situacao_anterior= CASE WHEN EXCLUDED.ultimo_ref > h.ultimo_ref AND EXCLUDED.situacao_ultima IS DISTINCT FROM h.situacao_ultima
                                THEN h.situacao_ultima ELSE h.situacao_anterior END,
        mudou_ref        = CASE WHEN EXCLUDED.ultimo_ref > h.ultimo_ref AND EXCLUDED.situacao_ultima IS DISTINCT FROM h.situacao_ultima
                                THEN EXCLUDED.ultimo_ref ELSE h.mudou_ref END,
        valor_ultimo     = CASE WHEN EXCLUDED.ultimo_ref >= h.ultimo_ref THEN EXCLUDED.valor_ultimo ELSE h.valor_ultimo END,
        situacao_ultima  = CASE WHEN EXCLUDED.ultimo_ref >= h.ultimo_ref THEN EXCLUDED.situacao_ultima ELSE h.situacao_ultima END,
        ajuizado_ultimo  = CASE WHEN EXCLUDED.ultimo_ref >= h.ultimo_ref THEN EXCLUDED.ajuizado_ultimo ELSE h.ajuizado_ultimo END,
        uf               = coalesce(EXCLUDED.uf, h.uf),
        receita          = coalesce(h.receita, EXCLUDED.receita),
        data_inscricao   = coalesce(h.data_inscricao, EXCLUDED.data_inscricao),
        ultimo_ref       = GREATEST(h.ultimo_ref, EXCLUDED.ultimo_ref)`, [dataRef, origem]);

    const [{ n }] = (await cli.query(`SELECT count(*)::bigint AS n FROM stage_u`)).rows;
    await cli.query("COMMIT");
    await q(`UPDATE fisco.pgfn_hist_carga SET status='ok', terminou_em=now(), linhas=$3, inscricoes=$4
              WHERE periodo=$1 AND origem=$2`, [periodo, origem, linhas, n]);
    console.log(`[pgfn-hist] ${origem} ${periodo}: ${linhas} linhas, ${aceitas} PJ principal, ${n} inscricoes`);
    return { linhas, inscricoes: Number(n) };
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    await q(`UPDATE fisco.pgfn_hist_carga SET status='erro', terminou_em=now(), erro=$3
              WHERE periodo=$1 AND origem=$2`,
      [periodo, origem, String(e instanceof Error ? e.message : e).slice(0, 400)]).catch(() => {});
    throw e;
  } finally {
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}

let rodando = false;
/**
 * Processa a fila: para cada base, os trimestres pendentes em ordem.
 * `limite` = quantos trimestres no maximo nesta passada (0 = todos).
 * Uma base que falha para ali (ordem cronologica), as outras seguem.
 */
export async function rodarHistorico(limite = 0) {
  if (rodando) return { feitos: 0, ocupado: true };
  rodando = true;
  let feitos = 0;
  try {
    await sincronizarFila();
    fora: for (const origem of ["PGFN_FGTS", "PGFN_PREV", "PGFN_GERAL"] as Origem[]) {
      const pend = await q<{ periodo: string }>(
        `SELECT periodo FROM fisco.pgfn_hist_carga
          WHERE origem = $1 AND status <> 'ok' ORDER BY periodo`, [origem]);
      for (const { periodo } of pend) {
        if (limite && feitos >= limite) break fora;
        try { await carregarTrimestre(periodo, origem); feitos++; }
        catch (e) {
          console.error(`[pgfn-hist] ${origem} ${periodo} falhou:`, e instanceof Error ? e.message : e);
          break;    // nao pula trimestre: a mudanca de situacao depende da ordem
        }
      }
    }
    if (feitos) await atualizarSinais();
    return { feitos };
  } finally { rodando = false; }
}

/** Recalcula a view de sinais depois de carregar trimestres novos. */
export async function atualizarSinais() {
  await q(`REFRESH MATERIALIZED VIEW fisco.mv_devedor_sinais`).catch((e) =>
    console.error("[pgfn-hist] sinais:", e instanceof Error ? e.message : e));
}

export async function estadoHistorico() {
  return q(`SELECT origem, count(*) FILTER (WHERE status='ok') AS ok, count(*) AS total,
                   max(data_ref) FILTER (WHERE status='ok') AS ultimo,
                   min(data_ref) FILTER (WHERE status='ok') AS primeiro,
                   max(erro) FILTER (WHERE status='erro') AS erro
              FROM fisco.pgfn_hist_carga GROUP BY origem ORDER BY origem`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , periodo, origem] = process.argv;
  if (periodo && origem) await carregarTrimestre(periodo, origem as Origem);
  else console.log(await rodarHistorico(Number(process.env.LIMITE || 0)));
  await pool.end();
}
