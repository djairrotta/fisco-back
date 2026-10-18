/**
 * Bases publicas extras por CNPJ. Cada fonte e recarregada inteira (apaga
 * e insere numa transacao) quando passa da validade. Fonte que falha nao
 * derruba as outras; o erro fica em fonte_extra.
 *
 * Fontes conferidas em 17/10/2026 (Receita no WebDAV novo; o antigo
 * dadosabertos.rfb.gov.br saiu do ar).
 */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import ExcelJS from "exceljs";
import { pool, q } from "../db/pool.js";

const RFB = "https://arquivos.receitafederal.gov.br/public.php/webdav/Dados";
const RFB_AUTH = "Basic " + Buffer.from(`${process.env.RFB_DADOS_TOKEN ?? "gn672Ad4CF8N6TK"}:`).toString("base64");

type Marca = { cnpj: string; tipo: string; ano?: number | null; valor?: number | null; detalhe?: Record<string, unknown> | null };

const so = (s: string) => (s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const cnpjOk = (s: string) => { const c = so(s); return /^[0-9A-Z]{12}\d{2}$/.test(c) ? c : null; };
const num = (s: string) => { const v = Number(String(s || "").replace(/\./g, "").replace(",", ".")); return Number.isFinite(v) ? v : null; };
const dataBr = (s: string) => { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((s || "").trim()); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
const csvSplit = (l: string, sep: string) => {
  if (!l.includes('"')) return l.split(sep);
  const out: string[] = []; let cur = "", aspas = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') { if (aspas && l[i + 1] === '"') { cur += '"'; i++; } else aspas = !aspas; }
    else if (c === sep && !aspas) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};

async function baixar(url: string, destino: string, auth?: string) {
  const r = await fetch(url, { headers: auth ? { Authorization: auth } : {}, redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`download ${r.status}: ${url}`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(destino));
}

/** Linhas de um arquivo remoto (CSV direto ou todos os CSV de um zip). */
async function* linhas(url: string, o: { auth?: string; enc?: BufferEncoding; zip?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "extra-"));
  try {
    const arq = join(dir, o.zip ? "a.zip" : "a.csv");
    await baixar(url, arq, o.auth);
    const fluxos: Readable[] = [];
    if (o.zip) {
      const z = await unzipper.Open.file(arq);
      for (const e of z.files) if (e.type === "File" && /\.(csv|txt)$/i.test(e.path)) fluxos.push(e.stream() as unknown as Readable);
    } else fluxos.push((await import("node:fs")).createReadStream(arq));
    for (const f of fluxos) {
      const rl = createInterface({ input: f.setEncoding(o.enc ?? "utf8"), crlfDelay: Infinity });
      for await (const l of rl) if (l.trim()) yield l.replace(/^﻿/, "");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Le um CSV com cabecalho e entrega objetos por nome de coluna (minusculo). */
async function* registros(url: string, sep: string, o: { auth?: string; enc?: BufferEncoding; zip?: boolean } = {}) {
  let cab: string[] | null = null;
  for await (const l of linhas(url, o)) {
    const p = csvSplit(l, sep).map((x) => x.trim());
    if (!cab) { cab = p.map((x) => x.toLowerCase()); continue; }
    if (p.length >= 2 && p[0] !== cab[0]) yield Object.fromEntries(cab.map((c, i) => [c, p[i] ?? ""])) as Record<string, string>;
  }
}

async function gravar(fonte: string, marcas: Marca[]) {
  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL statement_timeout = 0");
    await cli.query(`DELETE FROM empresa_marca WHERE fonte = $1`, [fonte]);
    for (let i = 0; i < marcas.length; i += 5000) {
      const f = marcas.slice(i, i + 5000);
      await cli.query(
        `INSERT INTO empresa_marca (cnpj_raiz, cnpj, fonte, tipo, ano, valor, detalhe)
         SELECT left(c, 8), c, $1, t, a, v, d::jsonb FROM unnest($2::text[], $3::text[], $4::int[], $5::numeric[], $6::text[]) AS x(c, t, a, v, d)`,
        [fonte, f.map((m) => m.cnpj), f.map((m) => m.tipo.slice(0, 120)), f.map((m) => m.ano ?? null), f.map((m) => m.valor ?? null),
         f.map((m) => (m.detalhe ? JSON.stringify(m.detalhe) : null))]);
    }
    await cli.query(`INSERT INTO fonte_extra (fonte, ultima_carga, linhas, erro, tentativa_em) VALUES ($1, now(), $2, NULL, now())
                     ON CONFLICT (fonte) DO UPDATE SET ultima_carga = now(), linhas = $2, erro = NULL, tentativa_em = now()`, [fonte, marcas.length]);
    await cli.query("COMMIT");
  } catch (e) { await cli.query("ROLLBACK").catch(() => {}); throw e; } finally { cli.release(); }
}

// ------------------------------------------------------------- fontes

async function sisen(): Promise<Marca[]> {
  const hoje = new Date().toISOString().slice(0, 10);
  const out: Marca[] = [];
  for await (const r of registros(`${RFB}/Cadastros/SISEN/empresas-habilitadas.csv`, ";", { auth: RFB_AUTH, enc: "latin1" })) {
    const c = cnpjOk(r["cnpj"]); if (!c) continue;
    const fim = dataBr(r["fim fruição"] ?? r["fim fruicao"] ?? "");
    if (fim && fim < hoje) continue;   // so beneficio vigente
    out.push({ cnpj: c, tipo: (r["tipo benefício fiscal"] ?? r["tipo beneficio fiscal"] ?? "").toUpperCase(), detalhe: { inicio: dataBr(r["início fruição"] ?? ""), fim } });
  }
  return out;
}

async function ecfRegime(): Promise<Marca[]> {
  const ultimo = new Map<string, { ano: number; tipo: string }>();
  for (const [arq, tipo] of [["entidades-lucro-real.zip", "real"], ["entidades-lucro-presumido.zip", "presumido"], ["entidades-lucro-arbitrado.zip", "arbitrado"], ["entidades-imunes-e-isentas.zip", "imune_isenta"]]) {
    for await (const r of registros(`${RFB}/Obrigacoes_Acessorias/ECF/${arq}`, ",", { auth: RFB_AUTH, zip: true })) {
      const c = cnpjOk(r["cnpj"]); const ano = Number(r["ano"]);
      if (!c || !ano || (r["cnpj_da_scp"] && r["cnpj_da_scp"] !== "0")) continue;
      const a = ultimo.get(c);
      if (!a || ano > a.ano) ultimo.set(c, { ano, tipo });
    }
  }
  return [...ultimo].map(([cnpj, v]) => ({ cnpj, tipo: v.tipo, ano: v.ano }));
}

const INCENTIVOS: Record<string, string> = {
  pat_deducao_ir: "pat", empresa_cidada_deducao_ir: "empresa_cidada", prouni_universidade_para_todos: "prouni",
  pronac_deducao_ir: "rouanet", incentivo_desporto: "desporto", rota_2030_deducao_ir: "rota_2030",
  fundos_direitos_crianca_adolescente: "fia", fundos_idoso: "fundo_idoso", perse_irpj: "perse", padis: "padis",
  atividade_audiov_deducao_ir: "audiovisual", pronon_deducao_ir: "pronon", pronas_pcd_deducao_ir: "pronas",
};
async function ecfRenuncia(): Promise<Marca[]> {
  const m = new Map<string, Marca>();
  for await (const r of registros(`${RFB}/Obrigacoes_Acessorias/ECF/renuncia-irpj-csll-ecf.csv`, "|", { auth: RFB_AUTH, enc: "latin1" })) {
    const c = cnpjOk(r["cnpj"]); const ano = Number(r["f0000_ano"]) || null;
    if (!c || (r["cod_scp"] && r["cod_scp"] !== "0")) continue;
    for (const [col, tipo] of Object.entries(INCENTIVOS)) {
      const v = num(r[col]); if (!v || v <= 0) continue;
      const k = `${c}|${tipo}`; const a = m.get(k);
      if (!a || (ano ?? 0) > (a.ano ?? 0)) m.set(k, { cnpj: c, tipo, ano, valor: v });
    }
  }
  return [...m.values()];
}

async function parcelamentos(): Promise<Marca[]> {
  const out: Marca[] = [];
  const base = `${RFB}/Creditos_Tributarios/Parcelamentos`;
  for (const [arq, tipo] of [
    ["parcelamento_convencional_SN-simples_nacional.csv", "simples"], ["parcelamento_especial_SN-simples_nacional.csv", "simples_especial"],
    ["parcelamento_convencional_MEI-microempreendedor_individual.csv", "mei"], ["parcelamento_especial_MEI-microempreendedor_individual.csv", "mei_especial"],
    ["parcelamento_ordinario_e_simplificado_PJ-pessoa_juridica_e_PF-pessoa_fisica.csv", "ordinario"], ["parcelamento_especial_PJ-pessoa_juridica_e_PF-pessoa_fisica.csv", "especial"],
  ]) {
    for await (const r of registros(`${base}/${arq}`, ";", { auth: RFB_AUTH })) {
      if (r["tipo"] && r["tipo"] !== "PJ") continue;
      const c = cnpjOk(r["cnpj"] ?? r["cpf_cnpj"]); if (!c) continue;
      out.push({ cnpj: c, tipo, valor: num(r["saldo_devedor"]),
        detalhe: { adesao: r["adesao_deferimento"] || null, parcelas: Number(r["qtde_parcelas"]) || null, parcelado: num(r["valor_parcelado"]) } });
    }
  }
  return out;
}

async function cgu(lista: "ceis" | "cnep"): Promise<Marca[]> {
  for (let d = 1; d <= 6; d++) {
    const dt = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
    try {
      const out: Marca[] = [];
      for await (const r of registros(`https://portaldatransparencia.gov.br/download-de-dados/${lista}/${dt}`, ";", { enc: "latin1", zip: true })) {
        if (r["tipo de pessoa"] !== "J") continue;
        const c = cnpjOk(r["cpf ou cnpj do sancionado"]); if (!c) continue;
        out.push({ cnpj: c, tipo: r["categoria da sanção"] || r["categoria da sancao"] || lista,
          detalhe: { inicio: dataBr(r["data início sanção"] ?? ""), fim: dataBr(r["data final sanção"] ?? ""), orgao: r["órgão sancionador"] ?? null } });
      }
      return out;
    } catch (e) { if (d === 6) throw e; }
  }
  return [];
}

async function listaSuja(): Promise<Marca[]> {
  const out: Marca[] = [];
  for await (const r of registros("https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/inspecao-do-trabalho/areas-de-atuacao/cadastro_de_empregadores.csv", ";", { enc: "latin1" })) {
    const k = Object.keys(r).find((x) => x.includes("cnpj")); const c = k ? cnpjOk(r[k]) : null;
    if (c) out.push({ cnpj: c, tipo: "cadastro_empregadores", ano: Number(r["ano da ação fiscal"]) || null });
  }
  return out;
}

async function leiDoBem(): Promise<Marca[]> {
  const out: Marca[] = [];
  const base = "https://www.gov.br/mcti/pt-br/acompanhe-o-mcti/lei-do-bem/paginas/mecanismos-de-transparencia";
  for (const [ano, suf] of [[2021, "/@@download/file"], [2020, "/@@download/file"], [2019, ""], [2018, ""]] as const) {
    const dir = await mkdtemp(join(tmpdir(), "ldb-"));
    try {
      const arq = join(dir, "a.xlsx");
      await baixar(`${base}/ano-base-${ano}.xlsx${suf}`, arq);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(arq);
      wb.eachSheet((ws) => ws.eachRow((row) => {
        const vals = (row.values as any[]).slice(1).map((v) => (v && typeof v === "object" && "result" in v ? v.result : v));
        const c = vals.map((v) => cnpjOk(String(v ?? "").padStart(14, "0"))).find(Boolean);
        if (!c) return;
        const valor = vals.filter((v) => typeof v === "number").pop() ?? null;
        out.push({ cnpj: c, tipo: "aprovada", ano, valor: typeof valor === "number" && valor > 9999 ? valor : null });
      }));
    } catch (e) { console.error(`[extras] lei do bem ${ano}:`, e instanceof Error ? e.message : e); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  return out;
}

async function anp(): Promise<Marca[]> {
  const out: Marca[] = [];
  for await (const r of registros("https://www.gov.br/anp/pt-br/centrais-de-conteudo/dados-abertos/arquivos/arquivos-dados-cadastrais-dos-revendedores-varejistas-de-combustiveis-automotivos/dados-cadastrais-revendedores-varejistas-combustiveis-automoveis.csv", ";", { enc: "latin1" })) {
    const c = cnpjOk(r["cnpj"]); if (c) out.push({ cnpj: c, tipo: "posto_combustivel", detalhe: { bandeira: r["bandeira"] || null } });
  }
  return out;
}

async function rntrc(): Promise<Marca[]> {
  const out: Marca[] = [];
  const mes = new Date(); mes.setUTCMonth(mes.getUTCMonth() - 1);
  const mm = String(mes.getUTCMonth() + 1).padStart(2, "0");
  const url = process.env.RNTRC_URL ?? `https://dados.antt.gov.br/dataset/b4a055d1-97a2-46f1-9461-cb17fbc6b6b3/resource/c77e6837-3f77-4c12-9937-e0f212a6a9a0/download/transportadores_rntrc_${mm}_${mes.getUTCFullYear()}.csv`;
  for await (const r of registros(url, ";", { enc: "latin1" })) {
    if (!/ativo/i.test(r["situacao_rntrc"] ?? "")) continue;
    const c = cnpjOk(r["cpfcnpjtransportador"]); if (c) out.push({ cnpj: c, tipo: (r["categoria_transportador"] || "transportador").toLowerCase() });
  }
  return out;
}

export const FONTES: Record<string, { rotulo: string; dias: number; carregar: () => Promise<Marca[]> }> = {
  ecf_regime: { rotulo: "Regime tributário (ECF)", dias: 30, carregar: ecfRegime },
  sisen: { rotulo: "Benefícios fiscais habilitados (SISEN)", dias: 30, carregar: sisen },
  incentivo: { rotulo: "Incentivos deduzidos no IRPJ (ECF)", dias: 30, carregar: ecfRenuncia },
  parcelamento: { rotulo: "Parcelamentos na Receita", dias: 7, carregar: parcelamentos },
  ceis: { rotulo: "Sanções CEIS (CGU)", dias: 7, carregar: () => cgu("ceis") },
  cnep: { rotulo: "Sanções CNEP (CGU)", dias: 7, carregar: () => cgu("cnep") },
  lista_suja: { rotulo: "Cadastro de empregadores (trabalho escravo)", dias: 30, carregar: listaSuja },
  lei_do_bem: { rotulo: "Lei do Bem (MCTI)", dias: 90, carregar: leiDoBem },
  anp: { rotulo: "Postos de combustível (ANP)", dias: 30, carregar: anp },
  rntrc: { rotulo: "Transportadores RNTRC (ANTT)", dias: 30, carregar: rntrc },
};

/** Recarrega as fontes vencidas (ou as pedidas). Uma por vez. */
export async function rodarBasesExtras(so?: string[]) {
  const estado = new Map((await q<any>(`SELECT * FROM fonte_extra`)).map((r) => [r.fonte, r]));
  const feitas: string[] = [];
  for (const [fonte, f] of Object.entries(FONTES)) {
    if (so && !so.includes(fonte)) continue;
    const e = estado.get(fonte);
    if (!so && e?.ultima_carga && Date.now() - new Date(e.ultima_carga).getTime() < f.dias * 864e5) continue;
    if (!so && e?.erro && e?.tentativa_em && Date.now() - new Date(e.tentativa_em).getTime() < 864e5) continue;
    try {
      const marcas = await f.carregar();
      if (!marcas.length) throw new Error("fonte veio vazia");
      await gravar(fonte, marcas);
      console.log(`[extras] ${fonte}: ${marcas.length}`);
      feitas.push(fonte);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 300);
      console.error(`[extras] ${fonte} falhou:`, msg);
      await q(`INSERT INTO fonte_extra (fonte, erro, tentativa_em) VALUES ($1, $2, now())
               ON CONFLICT (fonte) DO UPDATE SET erro = $2, tentativa_em = now()`, [fonte, msg]);
    }
  }
  return feitas;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const so = process.argv.slice(2);
  console.log(await rodarBasesExtras(so.length ? so : undefined));
  await pool.end();
}
