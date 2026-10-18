/**
 * Tabelas de referencia: CNAE (com secao), natureza juridica, qualificacao
 * de socio, motivo de situacao (Receita) e municipios com populacao e
 * coordenadas (IBGE + base publica de coordenadas das sedes).
 * Preenchidas no boot quando vazias; municipios atualizados uma vez por mes.
 */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import unzipper from "unzipper";
import { pool, q } from "../db/pool.js";

const RAIZ = process.env.RECEITA_WEBDAV_URL ?? "https://arquivos.receitafederal.gov.br/public.php/webdav";
const AUTH = "Basic " + Buffer.from(`${process.env.RECEITA_SHARE_TOKEN ?? "YggdBLfdninEJX9"}:`).toString("base64");

/** Secao da CNAE 2.0 a partir da divisao (2 primeiros digitos). */
export function secaoDaDivisao(div: number): string {
  const faixas: [number, number, string][] = [
    [1, 3, "A"], [5, 9, "B"], [10, 33, "C"], [35, 35, "D"], [36, 39, "E"], [41, 43, "F"], [45, 47, "G"],
    [49, 53, "H"], [55, 56, "I"], [58, 63, "J"], [64, 66, "K"], [68, 68, "L"], [69, 75, "M"], [77, 82, "N"],
    [84, 84, "O"], [85, 85, "P"], [86, 88, "Q"], [90, 93, "R"], [94, 96, "S"], [97, 97, "T"], [99, 99, "U"],
  ];
  return faixas.find(([a, b]) => div >= a && div <= b)?.[2] ?? "U";
}

export const SECOES: Record<string, string> = {
  A: "Agricultura, pecuária, produção florestal, pesca e aquicultura", B: "Indústrias extrativas",
  C: "Indústrias de transformação", D: "Eletricidade e gás", E: "Água, esgoto, resíduos e descontaminação",
  F: "Construção", G: "Comércio; reparação de veículos", H: "Transporte, armazenagem e correio",
  I: "Alojamento e alimentação", J: "Informação e comunicação", K: "Atividades financeiras e seguros",
  L: "Atividades imobiliárias", M: "Atividades profissionais, científicas e técnicas",
  N: "Atividades administrativas e serviços complementares", O: "Administração pública, defesa e seguridade",
  P: "Educação", Q: "Saúde humana e serviços sociais", R: "Artes, cultura, esporte e recreação",
  S: "Outras atividades de serviços", T: "Serviços domésticos", U: "Organismos internacionais",
};

/** Grupo da natureza juridica (tabela da Receita, 1o digito + casos). */
export function grupoNatureza(cod: string): string {
  if (/^1/.test(cod)) return "publica";
  if (["2135", "2305", "2313", "2321"].includes(cod)) return "empresario";   // empresario individual, EIRELI
  if (/^2/.test(cod)) return "sociedade";
  if (/^3/.test(cod)) return "sem_fins";
  if (/^4/.test(cod)) return "pessoa_fisica";
  return "outras";
}

async function lerZipRfb(periodo: string, nome: string): Promise<string[][]> {
  const r = await fetch(`${RAIZ}/${periodo}/${nome}`, { headers: { Authorization: AUTH } });
  if (!r.ok || !r.body) throw new Error(`${nome}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const zip = await unzipper.Open.buffer(buf);
  const out: string[][] = [];
  for (const e of zip.files) {
    if (e.type !== "File") continue;
    const rl = createInterface({ input: e.stream().setEncoding("latin1") as unknown as Readable, crlfDelay: Infinity });
    for await (const l of rl) {
      const p = l.split(";").map((x) => x.replace(/^"|"$/g, "").trim());
      if (p[0]) out.push(p);
    }
  }
  return out;
}

async function periodoRecente(): Promise<string> {
  const r = await fetch(`${RAIZ}/`, { method: "PROPFIND", headers: { Authorization: AUTH, Depth: "1" } });
  const xml = await r.text();
  const meses = [...xml.matchAll(/\/(\d{4}-\d{2})\/?<\/d:href>/gi)].map((m) => m[1]).sort();
  if (!meses.length) throw new Error("sem meses publicados");
  return meses[meses.length - 1];
}

export async function carregarReferenciasRfb() {
  const periodo = await periodoRecente();
  const [cnaes, naturezas, qualifs, motivos] = await Promise.all([
    lerZipRfb(periodo, "Cnaes.zip"), lerZipRfb(periodo, "Naturezas.zip"),
    lerZipRfb(periodo, "Qualificacoes.zip"), lerZipRfb(periodo, "Motivos.zip"),
  ]);
  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    for (const [c, d] of cnaes) {
      const cod = c.padStart(7, "0");
      if (!/^\d{7}$/.test(cod)) continue;
      await cli.query(`INSERT INTO fisco.cnae_ref VALUES ($1,$2,$3,$4) ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao`,
        [cod, d, cod.slice(0, 2), secaoDaDivisao(Number(cod.slice(0, 2)))]);
    }
    for (const [c, d] of naturezas) {
      const cod = c.padStart(4, "0");
      if (!/^\d{4}$/.test(cod)) continue;
      await cli.query(`INSERT INTO fisco.natureza_ref VALUES ($1,$2,$3) ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao, grupo = EXCLUDED.grupo`,
        [cod, d, grupoNatureza(cod)]);
    }
    for (const [c, d] of qualifs) if (/^\d+$/.test(c))
      await cli.query(`INSERT INTO fisco.qualificacao_ref VALUES ($1,$2) ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao`, [Number(c), d]);
    for (const [c, d] of motivos) if (/^\d+$/.test(c))
      await cli.query(`INSERT INTO fisco.motivo_situacao_ref VALUES ($1,$2) ON CONFLICT (codigo) DO UPDATE SET descricao = EXCLUDED.descricao`, [Number(c), d]);
    await cli.query("COMMIT");
    console.log(`[ref] ${cnaes.length} CNAEs, ${naturezas.length} naturezas, ${qualifs.length} qualificações, ${motivos.length} motivos`);
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { cli.release(); }
}

const COORDS = process.env.MUNICIPIOS_COORDS_URL
  ?? "https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv";
const POP = "https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/-1/variaveis/9324?localidades=N6%5Ball%5D";
const IBGE_MUN = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios";

export async function carregarMunicipios() {
  const [mun, coords, pop] = await Promise.all([
    fetch(IBGE_MUN).then((r) => r.json()) as Promise<any[]>,
    fetch(COORDS).then((r) => r.text()).catch(() => ""),
    fetch(POP).then((r) => r.json()).catch(() => null) as Promise<any>,
  ]);
  const xy = new Map<string, { lat: number; lon: number; capital: boolean }>();
  for (const l of coords.split("\n").slice(1)) {
    const p = l.split(",");
    if (p.length >= 5 && /^\d{7}$/.test(p[0])) xy.set(p[0], { lat: Number(p[2]), lon: Number(p[3]), capital: p[4] === "1" });
  }
  const habitantes = new Map<string, number>();
  for (const s of pop?.[0]?.resultados?.[0]?.series ?? []) {
    const v = Object.values(s.serie ?? {})[0];
    if (v && /^\d+$/.test(String(v))) habitantes.set(String(s.localidade.id), Number(v));
  }
  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    for (const m of mun) {
      const id = String(m.id);
      const uf = m?.microrregiao?.mesorregiao?.UF?.sigla ?? m?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla;
      if (!uf) continue;
      const c = xy.get(id);
      await cli.query(
        `INSERT INTO fisco.municipio_ref (municipio_ibge, nome, uf, populacao, lat, lon, capital, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,current_date)
         ON CONFLICT (municipio_ibge) DO UPDATE SET nome = EXCLUDED.nome, uf = EXCLUDED.uf,
           populacao = coalesce(EXCLUDED.populacao, fisco.municipio_ref.populacao),
           lat = coalesce(EXCLUDED.lat, fisco.municipio_ref.lat), lon = coalesce(EXCLUDED.lon, fisco.municipio_ref.lon),
           capital = EXCLUDED.capital, atualizado_em = current_date`,
        [id, m.nome, uf, habitantes.get(id) ?? null, c?.lat ?? null, c?.lon ?? null, c?.capital ?? false]);
    }
    await cli.query("COMMIT");
    console.log(`[ref] ${mun.length} municípios (${habitantes.size} com população, ${xy.size} com coordenadas)`);
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { cli.release(); }
}

/** No boot: preenche o que estiver vazio ou velho (municipios > 31 dias). */
export async function garantirReferencias() {
  const [{ cnae, mun, velho }] = await q<{ cnae: string; mun: string; velho: boolean }>(
    `SELECT (SELECT count(*) FROM fisco.cnae_ref) AS cnae, (SELECT count(*) FROM fisco.municipio_ref) AS mun,
            coalesce((SELECT max(atualizado_em) < current_date - 31 FROM fisco.municipio_ref), true) AS velho`);
  if (Number(cnae) === 0) await carregarReferenciasRfb().catch((e) => console.error("[ref] receita:", e instanceof Error ? e.message : e));
  if (Number(mun) === 0 || velho) await carregarMunicipios().catch((e) => console.error("[ref] municípios:", e instanceof Error ? e.message : e));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await carregarReferenciasRfb();
  await carregarMunicipios();
  await pool.end();
}
