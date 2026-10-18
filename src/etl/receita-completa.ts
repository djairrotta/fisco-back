/**
 * Carga da BASE COMPLETA da Receita (todas as empresas do Brasil) por
 * DIFERENCA, nao por substituicao.
 *
 * Por que diferenca: de um mes para o outro muda 1-2% do cadastro. Apagar
 * e reinserir 66 milhoes de linhas a cada mes reescreveria ~40 GB, seguraria
 * a tabela por uma hora e saturaria o disco do servidor (foi exatamente o
 * que travou a producao com a carga da PGFN). Aqui cada linha carrega o
 * hash da linha original da Receita; so entra UPDATE onde o hash mudou,
 * DELETE onde o CNPJ sumiu e INSERT onde apareceu. Leitores nunca ficam
 * bloqueados (so ha lock de linha) e cada UF e uma transacao curta.
 *
 * Ordem por mes: empresas (+ Simples) -> estabelecimentos -> socios ->
 * marcacao de contato do contador -> mv_raiz.
 * Empresas vem antes porque natureza, porte, capital e regime sao COPIADOS
 * para o estabelecimento (a pesquisa nao faz JOIN em 66 milhoes de linhas).
 *
 * Primeira carga (tabela quase vazia): os indices secundarios sao
 * derrubados antes do INSERT em massa e recriados depois. Inserir 66
 * milhoes de linhas mantendo indice de trigrama levaria um dia.
 *
 * RECEITA_SO_DEVEDORAS=true continua valendo: filtra pelas raizes com
 * divida (modo antigo, base pequena).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PoolClient } from "pg";
import unzipper from "unzipper";
import copy from "pg-copy-streams";
import { pool, q } from "../db/pool.js";
import {
  chaveNome, email, fragmentoCpf, mapaMunicipiosIbge, RaizesDevedoras, raizDaLinha, telefone,
  type MapaIbge,
} from "./receita-cnpj.js";

const RAIZ = process.env.RECEITA_WEBDAV_URL ?? "https://arquivos.receitafederal.gov.br/public.php/webdav";
const AUTH = "Basic " + Buffer.from(`${process.env.RECEITA_SHARE_TOKEN ?? "YggdBLfdninEJX9"}:`).toString("base64");
const soDevedoras = () => !/^(false|0|no|nao|não)$/i.test(process.env.RECEITA_SO_DEVEDORAS ?? "");
const LIMIAR_CARGA_INICIAL = 1_000_000;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const csv = (v: string) => (v === "" ? "" : /[";\n,{}]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const sim = (v: string) => /^S$/i.test((v || "").trim());
const dataRfb = (v: string) => {
  const s = (v || "").trim();
  if (!/^\d{8}$/.test(s) || s === "00000000" || Number(s.slice(0, 4)) < 1900) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};
/**
 * Campos de uma linha da Receita: `"a";"b";"c"`. Endereco e nome as vezes
 * trazem ";" dentro das aspas (`"SALA 1; BLOCO B"`), entao o separador e
 * `";"`, nao ";" solto. Linha sem aspas (raro) cai no split simples.
 */
export const campos = (linha: string) => {
  const l = linha.trim();
  if (l.startsWith('"') && l.endsWith('"')) return l.slice(1, -1).split('";"').map((x) => x.trim());
  return l.split(";").map((x) => x.replace(/^"|"$/g, "").trim());
};
/** Inteiro pequeno (smallint) ou vazio. */
const peq = (v: string) => (/^\d{1,4}$/.test(v || "") ? String(Number(v)) : "");

async function baixar(url: string, destino: string) {
  const r = await fetch(url, { headers: { Authorization: AUTH } });
  if (!r.ok || !r.body) throw new Error(`download falhou ${r.status}: ${url}`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(destino));
}

// So para teste local: RECEITA_SO_ARQUIVO=1 processa so Empresas1,
// Estabelecimentos1, Socios1 (e os arquivos unicos, como Simples).
const SO_ARQ = process.env.RECEITA_SO_ARQUIVO ?? "";

async function* linhasZip(periodo: string, dir: string, nomes: string[]) {
  for (const nome of SO_ARQ ? nomes.filter((n) => (!/\d\.zip$/.test(n) && n !== "Simples.zip") || n.endsWith(`${SO_ARQ}.zip`)) : nomes) {
    const local = join(dir, nome);
    await baixar(`${RAIZ}/${periodo}/${nome}`, local);
    console.log(`[rfb+] ${nome} baixado`);
    const zip = await unzipper.Open.file(local);
    for (const e of zip.files) {
      if (e.type !== "File") continue;
      const rl = createInterface({ input: e.stream().setEncoding("latin1") as any, crlfDelay: Infinity });
      for await (const l of rl) if (l.trim()) yield l;
    }
    await rm(local, { force: true });
  }
}

/** COPY de um gerador de linhas CSV para uma tabela. Devolve quantas linhas. */
async function copiar(cli: PoolClient, sql: string, linhas: AsyncIterable<string | null>) {
  const destino = cli.query(copy.from(sql) as never) as unknown as Writable;
  let erro: Error | null = null, n = 0, buf: string[] = [];
  destino.on("error", (e: Error) => { erro = e; });
  for await (const l of linhas) {
    if (erro) throw erro;
    if (!l) continue;
    buf.push(l); n++;
    if (buf.length >= 5000) {
      const b = buf.join(""); buf = [];
      if (!destino.write(b)) await new Promise<void>((ok) => destino.once("drain", () => ok()));
    }
  }
  if (buf.length) destino.write(buf.join(""));
  destino.end();
  await new Promise<void>((ok, err) => { if (erro) return err(erro); destino.on("finish", () => ok()); destino.on("error", err); });
  return n;
}

async function etapa(periodo: string, nome: string, status: string, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  await q(`INSERT INTO fisco.rfb_carga (periodo, etapa, status, comecou_em)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (periodo, etapa) DO UPDATE SET status = EXCLUDED.status,
             comecou_em = CASE WHEN EXCLUDED.status = 'carregando' THEN now() ELSE fisco.rfb_carga.comecou_em END,
             terminou_em = CASE WHEN EXCLUDED.status IN ('ok','erro') THEN now() ELSE NULL END`,
    [periodo, nome, status]);
  if (cols.length) {
    await q(`UPDATE fisco.rfb_carga SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")}
              WHERE periodo = $1 AND etapa = $2`, [periodo, nome, ...cols.map((c) => extra[c])]);
  }
}

// ---------------------------------------------------------------------
// Conversao de linhas (exportadas para teste)
// ---------------------------------------------------------------------

/** Empresas: raiz, razao, natureza, qualif. responsavel, capital, porte, ente. */
export function linhaEmpresaCompleta(linha: string): string | null {
  const p = campos(linha);
  if (p.length < 6) return null;
  const raiz = (p[0] || "").toUpperCase().padStart(8, "0");
  if (!/^[0-9A-Z]{8}$/.test(raiz)) return null;
  const capital = Number((p[4] || "").replace(/\./g, "").replace(",", "."));
  return [raiz, p[1] || "", /^\d{4}$/.test(p[2] || "") ? p[2] : "",
    peq(p[3]), Number.isFinite(capital) && capital < 1e15 ? String(capital) : "",
    peq(p[5]), p[6] || ""].map(csv).join(";") + "\n";
}

/** Simples: raiz, opcao, data opcao, data exclusao, mei, data opcao mei, data exclusao mei. */
export function linhaSimplesCompleta(linha: string): string | null {
  const p = campos(linha);
  if (p.length < 5) return null;
  const raiz = (p[0] || "").toUpperCase().padStart(8, "0");
  if (!/^[0-9A-Z]{8}$/.test(raiz)) return null;
  return [raiz, sim(p[1]) ? "true" : "false", dataRfb(p[2]), dataRfb(p[3]),
    sim(p[4]) ? "true" : "false", dataRfb(p[5] || ""), dataRfb(p[6] || "")].map(csv).join(";") + "\n";
}

/**
 * Estabelecimentos (30 colunas). Leva o hash da linha ORIGINAL: e ele que
 * decide se o estabelecimento mudou desde o mes passado.
 */
export function linhaEstabCompleta(linha: string, mapa: MapaIbge, nomesRfb: Map<string, string>): string | null {
  const p = campos(linha);
  if (p.length < 30) return null;
  const raiz = (p[0] || "").toUpperCase().padStart(8, "0");
  const cnpj = raiz + (p[1] || "").toUpperCase().padStart(4, "0") + (p[2] || "").padStart(2, "0");
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj)) return null;
  const uf = (p[19] || "").toUpperCase().slice(0, 2);
  if (uf.length !== 2) return null;
  const nomeMun = nomesRfb.get(p[20] || "") ?? "";
  const ibge = mapa.get(`${uf}|${chaveNome(nomeMun)}`) ?? "";
  const sec = (p[12] || "").split(",").map((c) => c.trim()).filter((c) => /^\d{7}$/.test(c));
  return [
    cnpj, raiz, p[3] === "1" ? "true" : "false", p[4] || "",
    peq(p[5]), dataRfb(p[6]), peq(p[7]),
    (p[11] || "").padStart(7, "0").slice(0, 7), sec.length ? `{${sec.join(",")}}` : "",
    dataRfb(p[10]), ibge, nomeMun, uf, (p[18] || "").replace(/\D/g, "").slice(0, 8),
    [p[13], p[14]].filter(Boolean).join(" "), p[15] || "", p[16] || "", p[17] || "",
    telefone(p[21] || "", p[22] || ""), telefone(p[23] || "", p[24] || ""), email(p[27] || ""),
    p[28] || "", md5(linha),
  ].map(csv).join(";") + "\n";
}

export function linhaSocioCompleta(linha: string): string | null {
  const p = campos(linha);
  if (p.length < 11) return null;
  const raiz = (p[0] || "").toUpperCase().padStart(8, "0");
  if (!/^[0-9A-Z]{8}$/.test(raiz) || !p[2]) return null;
  const tipo = p[1] === "1" ? "PJ" : p[1] === "3" ? "EX" : "PF";
  return [raiz, tipo, p[2], p[3] || "", tipo === "PF" ? fragmentoCpf(p[3] || "") : "", p[4] || "",
    dataRfb(p[5]), peq(p[10]), md5(linha)].map(csv).join(";") + "\n";
}

// ---------------------------------------------------------------------

async function nomesMunicipiosRfb(periodo: string, dir: string) {
  const m = new Map<string, string>();
  for await (const l of linhasZip(periodo, dir, ["Municipios.zip"])) {
    const p = campos(l);
    if (p.length >= 2 && p[0]) m.set(p[0], p[1]);
  }
  return m;
}

const filtroRaiz = async (cli: PoolClient) => (soDevedoras() ? RaizesDevedoras.doBanco(cli) : null);

/** Empresas + Simples -> empresa_rfb, por diferenca. Marca as raizes que mudaram. */
export async function carregarEmpresas(periodo: string) {
  const dir = await mkdtemp(join(tmpdir(), "rfbc-emp-"));
  const cli = await pool.connect();
  try {
    await etapa(periodo, "empresas", "carregando");
    const filtro = await filtroRaiz(cli);
    await cli.query(`DROP TABLE IF EXISTS fisco.rfb_stage_emp, fisco.rfb_stage_sim, fisco.rfb_raiz_mudou`);
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_stage_emp (cnpj_raiz char(8), razao_social text,
        natureza_juridica char(4), qualificacao_responsavel smallint, capital_social numeric(18,2),
        porte smallint, ente_federativo text)`);
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_stage_sim (cnpj_raiz char(8), opcao_simples boolean,
        data_opcao_simples date, data_exclusao_simples date, opcao_mei boolean, data_opcao_mei date, data_exclusao_mei date)`);
    let lidas = 0;
    const conv = (f: (l: string) => string | null) => async function* (it: AsyncIterable<string>) {
      for await (const l of it) { lidas++; if (filtro && !filtro.tem(raizDaLinha(l))) continue; yield f(l); }
    };
    await copiar(cli, `COPY fisco.rfb_stage_emp FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`,
      conv(linhaEmpresaCompleta)(linhasZip(periodo, dir, Array.from({ length: 10 }, (_, i) => `Empresas${i}.zip`))));
    await copiar(cli, `COPY fisco.rfb_stage_sim FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`,
      conv(linhaSimplesCompleta)(linhasZip(periodo, dir, ["Simples.zip"])));

    await cli.query("SET statement_timeout = 0");
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_stage_empresa AS
      SELECT DISTINCT ON (coalesce(e.cnpj_raiz, s.cnpj_raiz))
             coalesce(e.cnpj_raiz, s.cnpj_raiz) AS cnpj_raiz, e.razao_social, e.natureza_juridica,
             e.qualificacao_responsavel, e.capital_social, e.porte, e.ente_federativo,
             coalesce(s.opcao_simples, false) AS opcao_simples, s.data_opcao_simples, s.data_exclusao_simples,
             coalesce(s.opcao_mei, false) AS opcao_mei, s.data_opcao_mei, s.data_exclusao_mei,
             md5(row(e.razao_social, e.natureza_juridica, e.qualificacao_responsavel, e.capital_social, e.porte,
                     e.ente_federativo, s.opcao_simples, s.data_opcao_simples, s.data_exclusao_simples,
                     s.opcao_mei, s.data_opcao_mei, s.data_exclusao_mei)::text) AS hash_rfb
        FROM fisco.rfb_stage_emp e FULL JOIN fisco.rfb_stage_sim s ON s.cnpj_raiz = e.cnpj_raiz
       ORDER BY coalesce(e.cnpj_raiz, s.cnpj_raiz)`);
    await cli.query(`DROP TABLE fisco.rfb_stage_emp, fisco.rfb_stage_sim`);
    await cli.query(`CREATE UNIQUE INDEX ON fisco.rfb_stage_empresa (cnpj_raiz)`);
    await cli.query(`ANALYZE fisco.rfb_stage_empresa`);

    const atualizado = `${periodo}-01`;
    const COL = `razao_social, natureza_juridica, qualificacao_responsavel, capital_social, porte, ente_federativo,
                 opcao_simples, data_opcao_simples, data_exclusao_simples, opcao_mei, data_opcao_mei, data_exclusao_mei, hash_rfb`;
    // Raizes que mudaram (ou entraram): o estabelecimento delas precisa
    // receber os campos copiados de novo.
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_raiz_mudou AS
      SELECT s.cnpj_raiz FROM fisco.rfb_stage_empresa s
        LEFT JOIN fisco.empresa_rfb r ON r.cnpj_raiz = s.cnpj_raiz
       WHERE r.cnpj_raiz IS NULL OR r.hash_rfb IS DISTINCT FROM s.hash_rfb`);
    await cli.query(`CREATE UNIQUE INDEX ON fisco.rfb_raiz_mudou (cnpj_raiz)`);
    const del = await cli.query(`DELETE FROM fisco.empresa_rfb r
       WHERE NOT EXISTS (SELECT 1 FROM fisco.rfb_stage_empresa s WHERE s.cnpj_raiz = r.cnpj_raiz)`);
    const upd = await cli.query(`UPDATE fisco.empresa_rfb r SET (${COL}, atualizado_em) =
        (s.razao_social, s.natureza_juridica, s.qualificacao_responsavel, s.capital_social, s.porte, s.ente_federativo,
         s.opcao_simples, s.data_opcao_simples, s.data_exclusao_simples, s.opcao_mei, s.data_opcao_mei, s.data_exclusao_mei,
         s.hash_rfb, $1::date)
        FROM fisco.rfb_stage_empresa s
       WHERE s.cnpj_raiz = r.cnpj_raiz AND r.hash_rfb IS DISTINCT FROM s.hash_rfb`, [atualizado]);
    const ins = await cli.query(`INSERT INTO fisco.empresa_rfb (cnpj_raiz, ${COL}, atualizado_em)
        SELECT s.cnpj_raiz, ${COL.split(",").map((c) => "s." + c.trim()).join(", ")}, $1::date
          FROM fisco.rfb_stage_empresa s
         WHERE NOT EXISTS (SELECT 1 FROM fisco.empresa_rfb r WHERE r.cnpj_raiz = s.cnpj_raiz)`, [atualizado]);
    await cli.query(`DROP TABLE fisco.rfb_stage_empresa`);
    await cli.query("RESET statement_timeout");
    await etapa(periodo, "empresas", "ok", { lidas, inseridas: ins.rowCount, atualizadas: upd.rowCount, removidas: del.rowCount });
    console.log(`[rfb+] empresas ${periodo}: +${ins.rowCount} ~${upd.rowCount} -${del.rowCount}`);
  } catch (e) {
    await etapa(periodo, "empresas", "erro", { erro: String(e instanceof Error ? e.message : e).slice(0, 400) }).catch(() => {});
    throw e;
  } finally {
    await cli.query("RESET statement_timeout").catch(() => {});
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Indices secundarios do pai (para derrubar na carga inicial e recriar depois). */
async function indicesSecundarios(cli: PoolClient, tabela: string) {
  const { rows } = await cli.query<{ nome: string; def: string }>(
    `SELECT i.relname AS nome, pg_get_indexdef(i.oid) AS def
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
      WHERE x.indrelid = $1::regclass AND NOT x.indisprimary`, [tabela]);
  return rows.map((r) => ({ nome: r.nome, def: r.def.replace(" ON ONLY ", " ON ") }));
}

const COL_ESTAB = `cnpj, cnpj_raiz, matriz, nome_fantasia, situacao, data_situacao, motivo_situacao,
  cnae_principal, cnae_secundarios, data_abertura, municipio_ibge, municipio, uf, cep, logradouro,
  numero, complemento, bairro, telefone, telefone2, email, situacao_especial, hash_rfb`;

/** Estabelecimentos -> estabelecimento, por diferenca, uma UF por vez. */
export async function carregarEstabelecimentos(periodo: string) {
  const dir = await mkdtemp(join(tmpdir(), "rfbc-est-"));
  const cli = await pool.connect();
  try {
    await etapa(periodo, "estabelecimentos", "carregando");
    const filtro = await filtroRaiz(cli);
    const [ibge, nomes] = await Promise.all([mapaMunicipiosIbge(), nomesMunicipiosRfb(periodo, dir)]);
    await cli.query(`DROP TABLE IF EXISTS fisco.rfb_stage_estab`);
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_stage_estab (
        cnpj char(14), cnpj_raiz char(8), matriz boolean, nome_fantasia text, situacao smallint,
        data_situacao date, motivo_situacao smallint, cnae_principal char(7), cnae_secundarios char(7)[],
        data_abertura date, municipio_ibge char(7), municipio text, uf char(2), cep char(8), logradouro text,
        numero text, complemento text, bairro text, telefone text, telefone2 text, email text,
        situacao_especial text, hash_rfb text)`);
    let lidas = 0;
    const gerador = async function* () {
      for await (const l of linhasZip(periodo, dir, Array.from({ length: 10 }, (_, i) => `Estabelecimentos${i}.zip`))) {
        lidas++;
        if (filtro && !filtro.tem(raizDaLinha(l))) continue;
        yield linhaEstabCompleta(l, ibge, nomes);
      }
    };
    const n = await copiar(cli, `COPY fisco.rfb_stage_estab FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`, gerador());
    console.log(`[rfb+] estabelecimentos ${periodo}: ${lidas} lidas, ${n} no stage`);

    await cli.query("SET statement_timeout = 0");
    await cli.query("SET work_mem = '256MB'");
    // Nome da Receita diferente do IBGE (PARATI x Paraty, SANTANA DO
    // LIVRAMENTO x Sant'Ana do Livramento, BRASOPOLIS x Brazopolis): o que
    // nao casou pelo nome exato casa pelo mais parecido da mesma UF.
    const SEM_ACENTO = `upper(translate(r.nome, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÉÊÍÓÔÕÚÇ''', 'aaaaaeeeeiiiiooooouuuucAAAAEEIOOOUC '))`;
    const fix = await cli.query(`UPDATE fisco.rfb_stage_estab s SET municipio_ibge = m.ibge
        FROM (SELECT DISTINCT ON (x.uf, x.municipio) x.uf, x.municipio, r.municipio_ibge AS ibge
                FROM (SELECT DISTINCT uf, municipio FROM fisco.rfb_stage_estab
                       WHERE coalesce(municipio_ibge, '') = '' AND uf <> 'EX' AND municipio <> '') x
                JOIN fisco.municipio_ref r ON r.uf = x.uf AND similarity(${SEM_ACENTO}, x.municipio) > 0.4
               ORDER BY x.uf, x.municipio, similarity(${SEM_ACENTO}, x.municipio) DESC) m
       WHERE s.uf = m.uf AND s.municipio = m.municipio AND coalesce(s.municipio_ibge, '') = ''`)
      .catch((e: Error) => { console.error("[rfb+] municipios por semelhanca:", e.message); return { rowCount: 0 }; });
    if (fix.rowCount) console.log(`[rfb+] ${fix.rowCount} estabelecimentos com município casado por semelhança`);
    await cli.query(`CREATE INDEX ON fisco.rfb_stage_estab (uf, cnpj)`);
    await cli.query(`ANALYZE fisco.rfb_stage_estab`);

    const [{ n: existentes }] = (await cli.query(`SELECT count(*)::bigint AS n FROM fisco.estabelecimento`)).rows;
    const inicial = Number(existentes) < LIMIAR_CARGA_INICIAL;
    let derrubados: { nome: string; def: string }[] = [];
    if (inicial) {
      derrubados = (await indicesSecundarios(cli, "fisco.estabelecimento"))
        .filter((i) => i.nome !== "ix_estab_raiz");
      for (const i of derrubados) await cli.query(`DROP INDEX IF EXISTS fisco.${i.nome}`);
      // O que havia (modo so devedoras) sai inteiro: o INSERT em massa nao
      // atualiza linha existente.
      await cli.query(`DELETE FROM fisco.estabelecimento`);
      console.log(`[rfb+] carga inicial: ${derrubados.length} indices derrubados`);
    }

    const ufs = (await cli.query<{ uf: string }>(`SELECT DISTINCT uf FROM fisco.rfb_stage_estab ORDER BY 1`)).rows.map((r) => r.uf);
    const atualizado = `${periodo}-01`;
    // Campos copiados da empresa (empresa_rfb ja carregada nesta passada).
    const SEL = `${COL_ESTAB.split(",").map((c) => "s." + c.trim()).join(", ")},
      r.razao_social, r.natureza_juridica, r.porte, r.capital_social, r.opcao_simples, r.data_opcao_simples,
      r.data_exclusao_simples, r.opcao_mei, r.data_opcao_mei, r.data_exclusao_mei, $2::date`;
    const DEST = `${COL_ESTAB}, razao_social, natureza_juridica, porte, capital_social, opcao_simples,
      data_opcao_simples, data_exclusao_simples, opcao_mei, data_opcao_mei, data_exclusao_mei, atualizado_em`;
    const temMudou = !!(await cli.query(`SELECT to_regclass('fisco.rfb_raiz_mudou') AS t`)).rows[0].t;
    let ins = 0, upd = 0, del = 0;
    for (const uf of ufs) {
      await cli.query("BEGIN");
      await cli.query("SET LOCAL lock_timeout = '1min'");
      if (!inicial) {
        del += (await cli.query(`DELETE FROM fisco.estabelecimento t WHERE t.uf = $1
            AND NOT EXISTS (SELECT 1 FROM fisco.rfb_stage_estab s WHERE s.uf = $1 AND s.cnpj = t.cnpj)`, [uf])).rowCount ?? 0;
        upd += (await cli.query(`UPDATE fisco.estabelecimento t SET (${DEST}) = (${SEL})
            FROM fisco.rfb_stage_estab s LEFT JOIN fisco.empresa_rfb r ON r.cnpj_raiz = s.cnpj_raiz
           WHERE s.uf = $1 AND t.uf = $1 AND t.cnpj = s.cnpj
             AND (t.hash_rfb IS DISTINCT FROM s.hash_rfb
                  ${temMudou ? "OR EXISTS (SELECT 1 FROM fisco.rfb_raiz_mudou m WHERE m.cnpj_raiz = s.cnpj_raiz)" : ""})`,
          [uf, atualizado])).rowCount ?? 0;
      }
      ins += (await cli.query(`INSERT INTO fisco.estabelecimento (${DEST})
          SELECT ${SEL} FROM fisco.rfb_stage_estab s LEFT JOIN fisco.empresa_rfb r ON r.cnpj_raiz = s.cnpj_raiz
           WHERE s.uf = $1 ${inicial ? "" : "AND NOT EXISTS (SELECT 1 FROM fisco.estabelecimento t WHERE t.uf = $1 AND t.cnpj = s.cnpj)"}
          ON CONFLICT DO NOTHING`, [uf, atualizado])).rowCount ?? 0;
      await cli.query("COMMIT");
      console.log(`[rfb+] ${uf}: +${ins} ~${upd} -${del} (acumulado)`);
    }

    if (derrubados.length) {
      for (const i of derrubados) {
        console.log(`[rfb+] recriando ${i.nome}`);
        await cli.query(i.def);
      }
    }
    await cli.query(`DROP TABLE fisco.rfb_stage_estab`);
    await cli.query(`DROP TABLE IF EXISTS fisco.rfb_raiz_mudou`);
    await cli.query(`ANALYZE fisco.estabelecimento`);
    await etapa(periodo, "estabelecimentos", "ok", { lidas, inseridas: ins, atualizadas: upd, removidas: del });
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    await etapa(periodo, "estabelecimentos", "erro", { erro: String(e instanceof Error ? e.message : e).slice(0, 400) }).catch(() => {});
    throw e;
  } finally {
    await cli.query("RESET statement_timeout").catch(() => {});
    await cli.query("RESET work_mem").catch(() => {});
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}

const COL_SOCIO = `cnpj_raiz, tipo, nome, documento, fragmento, qualificacao, entrada, faixa_etaria, hash_rfb`;

/** Socios -> socio, por diferenca. */
export async function carregarSociosCompleto(periodo: string) {
  const dir = await mkdtemp(join(tmpdir(), "rfbc-soc-"));
  const cli = await pool.connect();
  try {
    await etapa(periodo, "socios", "carregando");
    const filtro = await filtroRaiz(cli);
    await cli.query(`DROP TABLE IF EXISTS fisco.rfb_stage_socio`);
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_stage_socio (cnpj_raiz char(8), tipo char(2), nome text,
        documento text, fragmento char(6), qualificacao text, entrada date, faixa_etaria smallint, hash_rfb text)`);
    let lidas = 0;
    const gerador = async function* () {
      for await (const l of linhasZip(periodo, dir, Array.from({ length: 10 }, (_, i) => `Socios${i}.zip`))) {
        lidas++;
        if (filtro && !filtro.tem(raizDaLinha(l))) continue;
        yield linhaSocioCompleta(l);
      }
    };
    await copiar(cli, `COPY fisco.rfb_stage_socio FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`, gerador());
    await cli.query("SET statement_timeout = 0");
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_stage_socio_u AS
        SELECT DISTINCT ON (cnpj_raiz, nome, coalesce(documento, '')) * FROM fisco.rfb_stage_socio
         ORDER BY cnpj_raiz, nome, coalesce(documento, ''), entrada DESC NULLS LAST`);
    await cli.query(`DROP TABLE fisco.rfb_stage_socio`);
    await cli.query(`CREATE UNIQUE INDEX ON fisco.rfb_stage_socio_u (cnpj_raiz, nome, coalesce(documento, ''))`);
    const atualizado = `${periodo}-01`;
    const chave = `s.cnpj_raiz = t.cnpj_raiz AND s.nome = t.nome AND coalesce(s.documento,'') = coalesce(t.documento,'')`;
    const del = await cli.query(`DELETE FROM fisco.socio t WHERE NOT EXISTS (SELECT 1 FROM fisco.rfb_stage_socio_u s WHERE ${chave})`);
    const upd = await cli.query(`UPDATE fisco.socio t SET (tipo, fragmento, qualificacao, entrada, faixa_etaria, hash_rfb, atualizado_em)
        = (s.tipo, s.fragmento, s.qualificacao, s.entrada, s.faixa_etaria, s.hash_rfb, $1::date)
        FROM fisco.rfb_stage_socio_u s WHERE ${chave} AND t.hash_rfb IS DISTINCT FROM s.hash_rfb`, [atualizado]);
    const ins = await cli.query(`INSERT INTO fisco.socio (${COL_SOCIO}, atualizado_em)
        SELECT ${COL_SOCIO.split(",").map((c) => "s." + c.trim()).join(", ")}, $1::date FROM fisco.rfb_stage_socio_u s
         WHERE NOT EXISTS (SELECT 1 FROM fisco.socio t WHERE ${chave})`, [atualizado]);
    await cli.query(`DROP TABLE fisco.rfb_stage_socio_u`);
    await etapa(periodo, "socios", "ok", { lidas, inseridas: ins.rowCount, atualizadas: upd.rowCount, removidas: del.rowCount });
    console.log(`[rfb+] socios ${periodo}: +${ins.rowCount} ~${upd.rowCount} -${del.rowCount}`);
  } catch (e) {
    await etapa(periodo, "socios", "erro", { erro: String(e instanceof Error ? e.message : e).slice(0, 400) }).catch(() => {});
    throw e;
  } finally {
    await cli.query("RESET statement_timeout").catch(() => {});
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Contato do CONTADOR: o mesmo e-mail ou telefone cadastrado em 5+
 * empresas diferentes (ou e-mail com "contab"/"contador" no endereco) e
 * do escritorio de contabilidade que abriu as empresas, nao delas. So
 * grava onde a marcacao muda.
 */
export async function marcarContador(periodo: string) {
  await etapa(periodo, "contador", "carregando");
  const cli = await pool.connect();
  try {
    await cli.query("SET statement_timeout = 0");
    await cli.query(`DROP TABLE IF EXISTS fisco.rfb_contato_rep`);
    await cli.query(`CREATE UNLOGGED TABLE fisco.rfb_contato_rep AS
      SELECT 'e'::char(1) AS tipo, email AS valor FROM fisco.estabelecimento WHERE email IS NOT NULL
       GROUP BY email HAVING count(DISTINCT cnpj_raiz) >= 5
      UNION ALL
      SELECT 't', telefone FROM fisco.estabelecimento WHERE telefone IS NOT NULL
       GROUP BY telefone HAVING count(DISTINCT cnpj_raiz) >= 5`);
    await cli.query(`CREATE INDEX ON fisco.rfb_contato_rep (tipo, valor)`);
    // So grava quem MUDA, e so o "true": as consultas leem coalesce(flag,
    // false), entao NULL ja vale "nao e do contador". Na carga inicial isso
    // escreve os positivos (minoria) em vez de reescrever 60 milhoes de linhas.
    const EH_EMAIL = `(e.email ~* 'contab|contador|contabil|escritorio|assessoria'
        OR EXISTS (SELECT 1 FROM fisco.rfb_contato_rep r WHERE r.tipo = 'e' AND r.valor = e.email))`;
    const EH_TEL = `EXISTS (SELECT 1 FROM fisco.rfb_contato_rep r WHERE r.tipo = 't' AND r.valor = e.telefone)`;
    const e1 = await cli.query(`UPDATE fisco.estabelecimento e SET email_contador = true
        WHERE e.email IS NOT NULL AND NOT coalesce(e.email_contador, false) AND ${EH_EMAIL}`);
    const e2 = await cli.query(`UPDATE fisco.estabelecimento e SET email_contador = NULL
        WHERE e.email_contador AND NOT (e.email IS NOT NULL AND ${EH_EMAIL})`);
    const t1 = await cli.query(`UPDATE fisco.estabelecimento e SET telefone_contador = true
        WHERE e.telefone IS NOT NULL AND NOT coalesce(e.telefone_contador, false) AND ${EH_TEL}`);
    const t2 = await cli.query(`UPDATE fisco.estabelecimento e SET telefone_contador = NULL
        WHERE e.telefone_contador AND NOT (e.telefone IS NOT NULL AND ${EH_TEL})`);
    const e = { rowCount: (e1.rowCount ?? 0) + (e2.rowCount ?? 0) };
    const t = { rowCount: (t1.rowCount ?? 0) + (t2.rowCount ?? 0) };
    await cli.query(`DROP TABLE fisco.rfb_contato_rep`);
    await etapa(periodo, "contador", "ok", { atualizadas: (e.rowCount ?? 0) + (t.rowCount ?? 0) });
  } catch (err) {
    await etapa(periodo, "contador", "erro", { erro: String(err instanceof Error ? err.message : err).slice(0, 400) }).catch(() => {});
    throw err;
  } finally {
    await cli.query("RESET statement_timeout").catch(() => {});
    cli.release();
  }
}

export async function atualizarRaiz(periodo: string) {
  await etapa(periodo, "raiz", "carregando");
  const [{ populada }] = await q<{ populada: boolean }>(
    `SELECT relispopulated AS populada FROM pg_class WHERE oid = 'fisco.mv_raiz'::regclass`);
  await q(`REFRESH MATERIALIZED VIEW ${populada ? "CONCURRENTLY" : ""} fisco.mv_raiz`);
  await etapa(periodo, "raiz", "ok");
}

/** Mes completo, na ordem. */
export async function carregarReceitaCompleta(periodo: string) {
  // Retoma de onde parou: um deploy no meio da carga (horas) nao obriga a
  // baixar de novo 4 GB de etapas que ja terminaram neste periodo.
  const feitas = new Set((await q<{ etapa: string }>(
    `SELECT etapa FROM fisco.rfb_carga WHERE periodo = $1 AND status = 'ok'`, [periodo])).map((x) => x.etapa));
  const passos: [string, (p: string) => Promise<unknown>][] = [
    ["empresas", carregarEmpresas], ["estabelecimentos", carregarEstabelecimentos], ["socios", carregarSociosCompleto],
    ["contador", marcarContador], ["raiz", atualizarRaiz],
  ];
  for (const [nome, f] of passos) {
    if (feitas.has(nome)) { console.log(`[rfb+] ${nome} ${periodo} já feito`); continue; }
    await f(periodo);
  }
}

/** Periodo cuja carga completa terminou (todas as etapas ok). */
export async function periodoCompletoCarregado(): Promise<string | null> {
  const [r] = await q<{ periodo: string }>(
    `SELECT periodo FROM fisco.rfb_carga GROUP BY periodo
      HAVING count(*) FILTER (WHERE status = 'ok') >= 5 ORDER BY periodo DESC LIMIT 1`);
  return r?.periodo ?? null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , periodo, alvo = "tudo"] = process.argv;
  if (!periodo) { console.log("uso: receita-completa.ts AAAA-MM [empresas|estab|socios|contador|raiz|tudo]"); process.exit(1); }
  if (alvo === "tudo") await carregarReceitaCompleta(periodo);
  if (alvo === "empresas") await carregarEmpresas(periodo);
  if (alvo === "estab") await carregarEstabelecimentos(periodo);
  if (alvo === "socios") await carregarSociosCompleto(periodo);
  if (alvo === "contador") await marcarContador(periodo);
  if (alvo === "raiz") await atualizarRaiz(periodo);
  await pool.end();
}
