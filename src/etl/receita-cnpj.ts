/**
 * ETL do cadastro de CNPJ da Receita Federal.
 *
 * Fonte: dadosabertos.rfb.gov.br/CNPJ/dados_abertos_cnpj/{AAAA-MM}/
 * Publicacao MENSAL. Arquivos sem cabecalho, ';' em LATIN1, divididos em
 * tres familias que so fazem sentido juntas:
 *   Estabelecimentos0..9.zip  endereco, situacao, CNAE, telefone, e-mail
 *   Empresas0..9.zip          razao social, porte, capital
 *   Simples.zip               opcao pelo Simples e pelo MEI
 *   Socios0..9.zip            quadro societario
 * Tudo se junta pela raiz do CNPJ (8 primeiros digitos).
 *
 * ARMADILHA QUE QUASE NINGUEM DOCUMENTA: a coluna MUNICIPIO do arquivo
 * NAO e o codigo do IBGE, e um codigo proprio da Receita. Como as paginas
 * publicas e a mv_municipio usam IBGE, aqui montamos a correspondencia
 * por UF + nome normalizado contra a lista oficial do IBGE. Municipio que
 * nao casar entra com municipio_ibge nulo em vez de receber codigo errado.
 *
 * NAO VERIFICADO DE PONTA A PONTA: o host da Receita recusa conexao de
 * fora do Brasil (TLS reset / 503), entao o download nao pode ser testado
 * do ambiente de desenvolvimento. A transformacao e o mapa de municipio
 * tem teste proprio; o download roda no servidor.
 */
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import copy from "pg-copy-streams";
import { pool } from "../db/pool.js";

// A Receita TIROU os arquivos de dadosabertos.rfb.gov.br. Desde 2025 eles
// ficam num compartilhamento Nextcloud, servido por WebDAV publico: o
// usuario e o token do compartilhamento e a senha e vazia. Listar os meses
// e PROPFIND; baixar e GET com o mesmo cabecalho. O endereco antigo deixou
// de responder, e foi por isso que a carga de CNPJ nunca rodou.
const RAIZ = process.env.RECEITA_WEBDAV_URL
  ?? "https://arquivos.receitafederal.gov.br/public.php/webdav";
const TOKEN_COMPARTILHAMENTO = process.env.RECEITA_SHARE_TOKEN ?? "YggdBLfdninEJX9";
const AUTH = "Basic " + Buffer.from(`${TOKEN_COMPARTILHAMENTO}:`).toString("base64");
const IBGE = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios";

/** Tira acento, pontuacao e caixa: "Mogi-Mirim" e "MOGI MIRIM" viram o mesmo. */
export function chaveNome(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export type MapaIbge = Map<string, string>;   // "SP|SAO PAULO" -> "3550308"

export async function mapaMunicipiosIbge(): Promise<MapaIbge> {
  const r = await fetch(IBGE);
  if (!r.ok) throw new Error(`IBGE respondeu ${r.status}`);
  const lista = (await r.json()) as any[];
  const m: MapaIbge = new Map();
  for (const x of lista) {
    // O IBGE devolve a UF por dois caminhos conforme o municipio; alguns
    // so trazem o moderno (regiao imediata), outros so o antigo.
    const uf = x?.microrregiao?.mesorregiao?.UF?.sigla
            ?? x?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla;
    if (!uf) continue;
    m.set(`${uf}|${chaveNome(x.nome)}`, String(x.id));
  }
  return m;
}

/** Meses publicados, lidos da listagem WebDAV (PROPFIND, profundidade 1). */
export async function mesesPublicadosReceita(): Promise<string[]> {
  const r = await fetch(`${RAIZ}/`, {
    method: "PROPFIND", headers: { Authorization: AUTH, Depth: "1" },
  });
  if (!r.ok) throw new Error(`listagem da Receita respondeu ${r.status}`);
  const xml = await r.text();
  const meses = new Set<string>();
  for (const m of xml.matchAll(/<d:href>[^<]*?\/(\d{4}-\d{2})\/?<\/d:href>/gi)) meses.add(m[1]);
  return [...meses].sort();
}

/** Sonda o mes mais recente publicado, sem baixar nada. */
export async function versaoDisponivelReceita(): Promise<string | null> {
  try {
    const meses = await mesesPublicadosReceita();
    if (meses.length) return meses[meses.length - 1];
  } catch { /* cai na sondagem mes a mes */ }
  const hoje = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1));
    const p = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    try {
      const r = await fetch(`${RAIZ}/${p}/Simples.zip`, {
        method: "HEAD", headers: { Authorization: AUTH },
      });
      if (r.ok) return p;
    } catch { /* tenta o mes anterior */ }
  }
  return null;
}

const sim = (v: string) => /^S$/i.test((v || "").trim());
const dataRfb = (v: string) => {
  const s = (v || "").trim();
  if (!/^\d{8}$/.test(s) || s === "00000000") return "";
  const a = s.slice(0, 4);
  if (Number(a) < 1900) return "";
  return `${a}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};
const csv = (v: string) => (v === "" ? "" : /[";\n,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Telefone utilizavel: DDD + numero, descartando lixo. */
export function telefone(ddd: string, num: string): string {
  const d = (ddd || "").replace(/\D/g, ""), n = (num || "").replace(/\D/g, "");
  if (d.length !== 2 || n.length < 8 || /^(0+|9+)$/.test(n)) return "";
  return d + n;
}

export function email(v: string): string {
  const e = (v || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e) ? e : "";
}

/** Uma linha de Estabelecimentos (30 colunas, sem cabecalho). */
export function linhaEstabelecimento(
  linha: string, mapa: MapaIbge, nomesRfb: Map<string, string>, atualizado: string
): string | null {
  const p = linha.split(";").map((x) => x.replace(/^"|"$/g, ""));
  if (p.length < 30) return null;

  // CNPJ alfanumerico (julho/2026): raiz e ordem aceitam A-Z.
  const raiz = (p[0] || "").toUpperCase().padStart(8, "0");
  const cnpj = raiz + (p[1] || "").toUpperCase().padStart(4, "0") + (p[2] || "").padStart(2, "0");
  if (!/^[0-9A-Z]{12}\d{2}$/.test(cnpj)) return null;

  const uf = (p[19] || "").trim().toUpperCase().slice(0, 2);
  if (uf.length !== 2) return null;

  const nomeMun = nomesRfb.get((p[20] || "").trim()) ?? "";
  const ibge = mapa.get(`${uf}|${chaveNome(nomeMun)}`) ?? "";

  const campos = [
    cnpj, raiz,
    (p[3] || "").trim() === "1" ? "true" : "false",   // matriz
    "",                                                // razao_social vem de Empresas
    (p[4] || "").trim(),                               // nome_fantasia
    (p[5] || "").trim(),                               // situacao (2 = ativa)
    dataRfb(p[6] || ""),
    (p[11] || "").trim().padStart(7, "0").slice(0, 7), // cnae principal
    "",                                                // cnae_secundarios: ver nota
    "", "",                                            // porte, capital (de Empresas)
    "", "",                                            // simples, mei (de Simples)
    dataRfb(p[10] || ""),                              // data_abertura
    ibge, nomeMun, uf,
    (p[18] || "").replace(/\D/g, "").slice(0, 8),      // cep
    [(p[13] || "").trim(), (p[14] || "").trim()].filter(Boolean).join(" "),
    (p[15] || "").trim(),                              // numero
    (p[17] || "").trim(),                              // bairro
    telefone(p[21] || "", p[22] || "") || telefone(p[23] || "", p[24] || ""),
    email(p[27] || ""),
    atualizado,
  ];
  return campos.map(csv).join(";") + "\n";
}

/**
 * Raizes de CNPJ com divida na PGFN, num vetor ordenado de inteiros.
 *
 * O cadastro inteiro da Receita tem ~65 milhoes de estabelecimentos e ~25
 * milhoes de socios. O produto so precisa dos que devem: guardar o resto
 * custaria dezenas de GB e horas de carga para nada. Um Set<string> com 4
 * milhoes de raizes ocupa ~300 MB; um Int32Array ordenado ocupa 16 MB e
 * responde por busca binaria. Raiz alfanumerica (CNPJ novo, julho/2026)
 * nao cabe em inteiro e vai para um Set pequeno a parte.
 */
export class RaizesDevedoras {
  private constructor(private num: Int32Array, private alfa: Set<string>) {}

  get tamanho() { return this.num.length + this.alfa.size; }

  static deLista(raizes: Iterable<string>): RaizesDevedoras {
    const n: number[] = []; const a = new Set<string>();
    for (const r of raizes) (/^\d{8}$/.test(r) ? n.push(Number(r)) : a.add(r));
    return new RaizesDevedoras(Int32Array.from(n).sort(), a);
  }

  /** Uma consulta, uma linha: string_agg evita 4 milhoes de objetos em memoria. */
  static async doBanco(cli: { query: (s: string) => Promise<any> }): Promise<RaizesDevedoras> {
    const { rows } = await cli.query(
      `SELECT string_agg(r, '') AS t FROM (
         SELECT DISTINCT cnpj_raiz AS r FROM fisco.divida_inscricao
          WHERE cnpj_raiz IS NOT NULL) x`);
    const t: string = rows[0]?.t ?? "";
    const lista: string[] = [];
    for (let i = 0; i + 8 <= t.length; i += 8) lista.push(t.slice(i, i + 8));
    return RaizesDevedoras.deLista(lista);
  }

  tem(raiz: string): boolean {
    if (!/^\d{8}$/.test(raiz)) return this.alfa.has(raiz);
    const x = Number(raiz); let lo = 0, hi = this.num.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >>> 1, v = this.num[m];
      if (v === x) return true;
      if (v < x) lo = m + 1; else hi = m - 1;
    }
    return false;
  }
}

/** Raiz da linha bruta sem dividir a linha inteira (filtro barato). */
export function raizDaLinha(bruta: string): string {
  const fim = bruta.indexOf(";");
  return (fim < 0 ? bruta : bruta.slice(0, fim)).replace(/"/g, "").trim().toUpperCase().padStart(8, "0");
}

/** RECEITA_SO_DEVEDORAS=false carrega o cadastro inteiro. */
const soDevedoras = () => !/^(false|0|no|nao|não)$/i.test(process.env.RECEITA_SO_DEVEDORAS ?? "");

const COLS = `cnpj, cnpj_raiz, matriz, razao_social, nome_fantasia, situacao,
              data_situacao, cnae_principal, cnae_secundarios, porte, capital_social,
              opcao_simples, opcao_mei, data_abertura, municipio_ibge, municipio,
              uf, cep, logradouro, numero, bairro, telefone, email, atualizado_em`;

async function baixar(url: string, destino: string): Promise<number> {
  const r = await fetch(url, { headers: { Authorization: AUTH } });
  if (!r.ok || !r.body) throw new Error(`download falhou ${r.status}: ${url}`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(destino));
  return (await stat(destino)).size;
}

/** Tabela de municipios da propria Receita: codigo -> nome. */
async function nomesMunicipiosRfb(periodo: string, dir: string): Promise<Map<string, string>> {
  const z = join(dir, "Municipios.zip");
  await baixar(`${RAIZ}/${periodo}/Municipios.zip`, z);
  const m = new Map<string, string>();
  const zip = await unzipper.Open.file(z);
  for (const e of zip.files) {
    if (e.type !== "File") continue;
    const rl = createInterface({ input: e.stream().setEncoding("latin1") as any, crlfDelay: Infinity });
    for await (const l of rl) {
      const p = l.split(";").map((x) => x.replace(/^"|"$/g, "").trim());
      if (p.length >= 2 && p[0]) m.set(p[0], p[1]);
    }
  }
  return m;
}

/**
 * Carga completa de um mes. Em series de proposito: sao dezenas de GB
 * descompactados e paralelizar so multiplica a pressao em disco.
 */
export async function carregarReceita(periodo: string) {
  const dir = await mkdtemp(join(tmpdir(), "rfb-"));
  const atualizado = `${periodo}-01`;
  const cli = await pool.connect();
  let lidas = 0, aceitas = 0;

  try {
    const [ibge, nomes] = await Promise.all([
      mapaMunicipiosIbge(),
      nomesMunicipiosRfb(periodo, dir),
    ]);
    console.log(`[rfb] ${ibge.size} municípios do IBGE, ${nomes.size} códigos da Receita`);
    const filtro = soDevedoras() ? await RaizesDevedoras.doBanco(cli) : null;
    if (filtro) console.log(`[rfb] filtrando por ${filtro.tamanho} raízes com dívida`);

    await cli.query("BEGIN");
    await cli.query(`CREATE TEMP TABLE stage_estab
                     (LIKE fisco.estabelecimento INCLUDING DEFAULTS) ON COMMIT DROP`);
    const destino = cli.query(copy.from(
      `COPY stage_estab (${COLS}) FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`
    ) as unknown as never) as unknown as Writable;

    for (let i = 0; i <= 9; i++) {
      const nome = `Estabelecimentos${i}.zip`;
      const local = join(dir, nome);
      const bytes = await baixar(`${RAIZ}/${periodo}/${nome}`, local);
      console.log(`[rfb] ${nome}: ${(bytes / 1e6).toFixed(0)} MB`);
      const zip = await unzipper.Open.file(local);
      for (const e of zip.files) {
        if (e.type !== "File") continue;
        const rl = createInterface({ input: e.stream().setEncoding("latin1") as any, crlfDelay: Infinity });
        for await (const bruta of rl) {
          if (!bruta.trim()) continue;
          lidas++;
          if (filtro && !filtro.tem(raizDaLinha(bruta))) continue;
          const l = linhaEstabelecimento(bruta, ibge, nomes, atualizado);
          if (!l) continue;
          aceitas++;
          if (!destino.write(l)) await new Promise<void>((r) => destino.once("drain", () => r()));
        }
      }
      await rm(local, { force: true });
    }
    destino.end();
    await new Promise<void>((ok, err) => { destino.on("finish", () => ok()); destino.on("error", err); });

    await cli.query(`DELETE FROM fisco.estabelecimento`);
    await cli.query(`INSERT INTO fisco.estabelecimento (${COLS}) SELECT ${COLS} FROM stage_estab`);
    await cli.query("COMMIT");
    console.log(`[rfb] ${periodo}: ${lidas} lidas, ${aceitas} aceitas`);
    return { lidas, aceitas };
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}




// =====================================================================
// SOCIOS
//
// Layout (11 colunas, sem cabecalho, ';' em LATIN1):
//   0 CNPJ_BASICO                 6 PAIS
//   1 IDENTIFICADOR_SOCIO         7 REPRESENTANTE_LEGAL (CPF mascarado)
//   2 NOME_SOCIO_RAZAO_SOCIAL     8 NOME_REPRESENTANTE
//   3 CNPJ_CPF_SOCIO              9 QUALIFICACAO_REPRESENTANTE
//   4 QUALIFICACAO_SOCIO         10 FAIXA_ETARIA
//   5 DATA_ENTRADA_SOCIEDADE
//
// IDENTIFICADOR_SOCIO: 1 = pessoa juridica, 2 = pessoa fisica,
// 3 = estrangeiro.
//
// O CPF do socio vem MASCARADO: ***059052**. Confirmado contra o dado
// real. Sao os mesmos 6 digitos do meio que a PGFN publica em
// XXX878.325XX, e e isso que permite cruzar os dois.
// =====================================================================

const COLS_SOCIO = `cnpj_raiz, tipo, nome, documento, fragmento,
                    qualificacao, entrada, faixa_etaria, atualizado_em`;

/** Os 6 digitos que sobrevivem a mascara, nos dois formatos. */
export function fragmentoCpf(v: string): string {
  const d = (v || "").replace(/\D/g, "");
  if (d === "000000") return "";          // sentinela de campo vazio
  if (d.length === 6) return d;
  if (d.length === 11) return d.slice(3, 9);
  return "";
}

export function linhaSocio(linha: string, atualizado: string): string | null {
  const p = linha.split(";").map((x) => x.replace(/^"|"$/g, "").trim());
  if (p.length < 11) return null;

  const raiz = (p[0] || "").toUpperCase().padStart(8, "0");
  if (!/^[0-9A-Z]{8}$/.test(raiz)) return null;

  const nome = p[2] || "";
  if (!nome) return null;

  const tipo = p[1] === "1" ? "PJ" : p[1] === "3" ? "EX" : "PF";
  const doc = p[3] || "";

  const campos = [
    raiz, tipo, nome, doc,
    tipo === "PF" ? fragmentoCpf(doc) : "",
    p[4] || "",
    dataRfb(p[5] || ""),
    /^\d+$/.test(p[10] || "") ? p[10] : "",
    atualizado,
  ];
  return campos.map(csv).join(";") + "\n";
}

export async function carregarSocios(periodo: string) {
  const dir = await mkdtemp(join(tmpdir(), "rfb-soc-"));
  const atualizado = `${periodo}-01`;
  const cli = await pool.connect();
  let lidas = 0, aceitas = 0;

  try {
    const filtro = soDevedoras() ? await RaizesDevedoras.doBanco(cli) : null;
    if (filtro) console.log(`[rfb] sócios: filtrando por ${filtro.tamanho} raízes com dívida`);
    await cli.query("BEGIN");
    await cli.query(`CREATE TEMP TABLE stage_socio
                     (LIKE fisco.socio INCLUDING DEFAULTS) ON COMMIT DROP`);
    const destino = cli.query(copy.from(
      `COPY stage_socio (${COLS_SOCIO}) FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`
    ) as unknown as never) as unknown as Writable;

    for (let i = 0; i <= 9; i++) {
      const nome = `Socios${i}.zip`;
      const local = join(dir, nome);
      const bytes = await baixar(`${RAIZ}/${periodo}/${nome}`, local);
      console.log(`[rfb] ${nome}: ${(bytes / 1e6).toFixed(0)} MB`);
      const zip = await unzipper.Open.file(local);
      for (const e of zip.files) {
        if (e.type !== "File") continue;
        const rl = createInterface({ input: e.stream().setEncoding("latin1") as any, crlfDelay: Infinity });
        for await (const bruta of rl) {
          if (!bruta.trim()) continue;
          lidas++;
          if (filtro && !filtro.tem(raizDaLinha(bruta))) continue;
          const l = linhaSocio(bruta, atualizado);
          if (!l) continue;
          aceitas++;
          if (!destino.write(l)) await new Promise<void>((r) => destino.once("drain", () => r()));
        }
      }
      await rm(local, { force: true });
    }
    destino.end();
    await new Promise<void>((ok, err) => { destino.on("finish", () => ok()); destino.on("error", err); });

    await cli.query(`DELETE FROM fisco.socio`);
    // O arquivo repete o mesmo socio em linhas identicas; a PK rejeitaria.
    await cli.query(`INSERT INTO fisco.socio (${COLS_SOCIO})
                     SELECT DISTINCT ON (cnpj_raiz, nome, coalesce(documento,''))
                            ${COLS_SOCIO} FROM stage_socio`);
    await cli.query("COMMIT");
    console.log(`[rfb] socios ${periodo}: ${lidas} lidas, ${aceitas} aceitas`);
    return { lidas, aceitas };
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // uso: node dist/etl/receita-cnpj.js [periodo] [estabelecimentos|socios|tudo]
  const periodo = process.argv[2] ?? (await versaoDisponivelReceita());
  const alvo = (process.argv[3] ?? "tudo").toLowerCase();
  if (!periodo) { console.error("nenhum período disponível"); process.exit(1); }
  console.log(`[rfb] período ${periodo}, alvo ${alvo}`);
  if (alvo === "tudo" || alvo.startsWith("estab")) await carregarReceita(periodo);
  if (alvo === "tudo" || alvo.startsWith("soc")) await carregarSocios(periodo);
  await pool.end();
}
