/**
 * PESQUISA DE EMPRESAS na base completa da Receita (todas as empresas do
 * Brasil, nao so as devedoras), com os filtros do EmpresAqui e os de
 * divida/momento da divida do fisco.
 *
 * Roda direto em `estabelecimento` (particionada por UF). Os campos da
 * empresa (natureza, porte, capital, regime) ja estao copiados no
 * estabelecimento pela carga. Divida e sinais entram por EXISTS na
 * mv_devedor/mv_devedor_sinais (uma linha por raiz, indice unico).
 *
 * Contagem com teto (100 mil): contar milhoes de linhas a cada clique e
 * caro e ninguem precisa do numero exato acima disso.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { lista, memo, numero, sessao } from "../lib/http.js";
import { viewPronta } from "../db/views-boot.js";
import { montarFiltro, type Filtros } from "./pesquisa.js";
import { SECOES } from "../services/referencias.js";

export interface FiltrosBusca {
  q?: string; email?: string; telefone?: string; cnpjs?: string;
  secao?: string; cnae?: string; cnae_secundario?: string;
  uf?: string; municipio?: string; bairro?: string; cep?: string; logradouro?: string; numero?: string;
  raio_km?: string; raio_municipio?: string; hab_min?: string; hab_max?: string;
  situacao?: string; situacao_de?: string; situacao_ate?: string;
  matriz?: string; filiais_min?: string; natureza?: string;
  abertura_de?: string; abertura_ate?: string; idade_min?: string; idade_max?: string;
  porte?: string; mei?: string; simples?: string; regime?: string; faturamento?: string;
  capital_min?: string; capital_max?: string; socios_min?: string; socios_max?: string;
  contato?: string; ocultar_contador?: string; recuperacao?: string;
  divida?: string; valor_min?: string; valor_max?: string; tributo?: string; ajuizada?: string;
  acordo?: string; sinal?: string; programa?: string; estadual?: string;
  ordem?: string; pagina?: string; limite?: string;
}

const ORDENS: Record<string, string> = {
  contatos: "e.pontos_contato DESC NULLS LAST, e.data_abertura DESC NULLS LAST",
  recentes: "e.data_abertura DESC NULLS LAST",
  antigas: "e.data_abertura ASC NULLS LAST",
  capital_desc: "e.capital_social DESC NULLS LAST",
  capital_asc: "e.capital_social ASC NULLS LAST",
  razao: "e.razao_social ASC NULLS LAST",
  municipio: "e.municipio ASC NULLS LAST, e.razao_social ASC",
  divida: "(SELECT d.valor_total FROM mv_devedor d WHERE d.cnpj_raiz = e.cnpj_raiz) DESC NULLS LAST",
  situacao: "e.data_situacao DESC NULLS LAST",
};

const TETO = 100_000;
const dataOk = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (s?: string) => (s && Number(s) > 0 ? Number(s) : null);

/** Monta o WHERE da pesquisa. Exportado para teste. */
export async function montarBusca(f: FiltrosBusca) {
  const onde: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => {
    let s = sql;
    for (const x of v) { p.push(x); s = s.replace("?", `$${p.length}`); }
    onde.push(s);
  };

  // Texto: CNPJ (completo ou raiz) ou nome
  const t = (f.q || "").trim();
  if (t) {
    const c = t.replace(/[\s./-]/g, "").toUpperCase();
    if (/^[0-9A-Z]{12}\d{2}$/.test(c) && /\d/.test(c)) add("e.cnpj = ?", c);
    else if (/^\d{8}$/.test(c)) add("e.cnpj_raiz = ?", c);
    else add("(e.razao_social ILIKE ? OR e.nome_fantasia ILIKE ?)", `%${t}%`, `%${t}%`);
  }
  const cnpjs = lista(f.cnpjs).map((x) => x.replace(/[^0-9A-Z]/gi, "").toUpperCase()).filter((x) => /^[0-9A-Z]{12}\d{2}$/.test(x));
  if (cnpjs.length) add("e.cnpj = ANY(?)", cnpjs.slice(0, 5000));
  if (f.email?.trim()) {
    const v = f.email.trim().toLowerCase();
    if (v.includes("@")) add("e.email = ?", v); else add("e.email LIKE ?", `%@${v.replace(/^www\./, "")}`);
  }
  if (f.telefone?.replace(/\D/g, "")) {
    const v = f.telefone.replace(/\D/g, "");
    add("(e.telefone LIKE ? OR e.telefone2 LIKE ?)", `%${v}`, `%${v}`);
  }

  // Segmento
  const secoes = lista(f.secao).map((x) => x.toUpperCase()).filter((x) => SECOES[x]);
  const cnaesBrutos = lista(f.cnae).map((x) => x.replace(/\D/g, "")).filter((x) => x.length >= 2 && x.length <= 7);
  if (secoes.length || cnaesBrutos.length) {
    const codigos = await q<{ codigo: string }>(
      `SELECT codigo FROM cnae_ref WHERE secao = ANY($1) OR codigo LIKE ANY($2)`,
      [secoes, cnaesBrutos.map((c) => `${c}%`)]);
    const cod = codigos.map((x) => x.codigo);
    if (f.cnae_secundario === "1") add("(e.cnae_principal = ANY(?) OR e.cnae_secundarios && ?::char(7)[])", cod, cod);
    else add("e.cnae_principal = ANY(?)", cod);
  }

  // Localizacao
  const ufs = lista(f.uf).map((u) => u.toUpperCase()).filter((u) => /^[A-Z]{2}$/.test(u));
  if (ufs.length) add("e.uf = ANY(?)", ufs);
  const muns = lista(f.municipio).filter((m) => /^\d{7}$/.test(m));
  const raio = num(f.raio_km);
  if (raio && /^\d{7}$/.test(f.raio_municipio || "")) {
    add(`e.municipio_ibge IN (SELECT m.municipio_ibge FROM municipio_ref m, municipio_ref c
          WHERE c.municipio_ibge = ? AND m.lat IS NOT NULL AND
          6371 * 2 * asin(sqrt(power(sin(radians(m.lat - c.lat) / 2), 2) +
            cos(radians(c.lat)) * cos(radians(m.lat)) * power(sin(radians(m.lon - c.lon) / 2), 2))) <= ?)`,
      f.raio_municipio, Math.min(raio, 1000));
  } else if (muns.length) add("e.municipio_ibge = ANY(?)", muns);
  const hmin = num(f.hab_min), hmax = num(f.hab_max);
  if (hmin || hmax) add(`e.municipio_ibge IN (SELECT municipio_ibge FROM municipio_ref
      WHERE populacao >= ? AND populacao <= ?)`, hmin ?? 0, hmax ?? 2_000_000_000);
  if (f.bairro?.trim()) add("e.bairro ILIKE ?", `%${f.bairro.trim()}%`);
  if (f.cep?.replace(/\D/g, "")) add("e.cep LIKE ?", `${f.cep.replace(/\D/g, "").slice(0, 8)}%`);
  if (f.logradouro?.trim()) add("e.logradouro ILIKE ?", `%${f.logradouro.trim()}%`);
  if (f.numero?.trim()) add("e.numero = ?", f.numero.trim());

  // Situacao cadastral (padrao: so ativas)
  const sit = f.situacao === "todas" ? [] : (lista(f.situacao).length ? lista(f.situacao) : ["2"]);
  const sitN = sit.map(Number).filter((x) => [1, 2, 3, 4, 8].includes(x));
  if (sitN.length) add("e.situacao = ANY(?::smallint[])", sitN);
  if (dataOk(f.situacao_de)) add("e.data_situacao >= ?::date", f.situacao_de);
  if (dataOk(f.situacao_ate)) add("e.data_situacao <= ?::date", f.situacao_ate);

  // Perfil
  if (f.matriz === "matriz") onde.push("e.matriz");
  if (f.matriz === "filial") onde.push("NOT e.matriz");
  const filiais = num(f.filiais_min);
  if (filiais && (await viewPronta("mv_raiz"))) add("EXISTS (SELECT 1 FROM mv_raiz r WHERE r.cnpj_raiz = e.cnpj_raiz AND r.qtd_estab - 1 >= ?)", filiais);
  const naturezas = lista(f.natureza);
  const grupos = naturezas.filter((n) => n.startsWith("g:")).map((n) => n.slice(2));
  const codigosNat = naturezas.filter((n) => /^\d{4}$/.test(n));
  if (grupos.length || codigosNat.length)
    add("(e.natureza_juridica = ANY(?) OR e.natureza_juridica IN (SELECT codigo FROM natureza_ref WHERE grupo = ANY(?)))", codigosNat, grupos);
  if (dataOk(f.abertura_de)) add("e.data_abertura >= ?::date", f.abertura_de);
  if (dataOk(f.abertura_ate)) add("e.data_abertura <= ?::date", f.abertura_ate);
  const imin = num(f.idade_min), imax = num(f.idade_max);
  if (imin) add("e.data_abertura <= current_date - make_interval(years => ?)", imin);
  if (imax) add("e.data_abertura > current_date - make_interval(years => ?)", imax);
  const portes = lista(f.porte).map(Number).filter((x) => [1, 3, 5].includes(x));
  if (portes.length) add("e.porte = ANY(?::smallint[])", portes);
  if (f.mei === "sim") onde.push("e.opcao_mei");
  if (f.mei === "nao") onde.push("NOT coalesce(e.opcao_mei, false)");
  if (f.mei === "excluido") onde.push("e.data_exclusao_mei IS NOT NULL AND NOT coalesce(e.opcao_mei, false)");
  if (f.simples === "optante") onde.push("e.opcao_simples");
  if (f.simples === "nao") onde.push("NOT coalesce(e.opcao_simples, false)");
  if (f.simples === "excluido") onde.push("e.data_exclusao_simples IS NOT NULL AND NOT coalesce(e.opcao_simples, false)");
  const regimes = lista(f.regime);
  if (regimes.length) {
    const r: string[] = [];
    if (regimes.includes("mei")) r.push("coalesce(e.opcao_mei, false)");
    if (regimes.includes("simples")) r.push("(coalesce(e.opcao_simples, false) AND NOT coalesce(e.opcao_mei, false))");
    if (regimes.includes("demais")) r.push("NOT coalesce(e.opcao_simples, false)");
    if (r.length) onde.push(`(${r.join(" OR ")})`);
  }
  // Faturamento presumido pelo enquadramento legal (MEI ate 81 mil, ME ate
  // 360 mil, EPP ate 4,8 milhoes). E o limite da lei, nao o faturamento real.
  const fat = lista(f.faturamento);
  if (fat.length) {
    const r: string[] = [];
    if (fat.includes("ate81k")) r.push("coalesce(e.opcao_mei, false)");
    if (fat.includes("ate360k")) r.push("(e.porte = 1 AND NOT coalesce(e.opcao_mei, false))");
    if (fat.includes("ate4800k")) r.push("e.porte = 3");
    if (fat.includes("acima")) r.push("e.porte = 5");
    if (r.length) onde.push(`(${r.join(" OR ")})`);
  }
  const cmin = num(f.capital_min), cmax = num(f.capital_max);
  if (cmin) add("e.capital_social >= ?", cmin);
  if (cmax) add("e.capital_social <= ?", cmax);
  const smin = num(f.socios_min), smax = num(f.socios_max);
  if ((smin || smax) && (await viewPronta("mv_raiz")))
    add("EXISTS (SELECT 1 FROM mv_raiz r WHERE r.cnpj_raiz = e.cnpj_raiz AND r.qtd_socios >= ? AND r.qtd_socios <= ?)", smin ?? 0, smax ?? 100000);
  if (f.recuperacao === "1") onde.push("e.razao_social ~ 'RECUPERACAO JUDICIAL'");

  // Contato (ocultar contador: contato do contador nao conta)
  const semCont = f.ocultar_contador === "1";
  const contatos = lista(f.contato);
  if (contatos.includes("email")) onde.push(semCont ? "(e.email IS NOT NULL AND NOT coalesce(e.email_contador, false))" : "e.email IS NOT NULL");
  if (contatos.includes("telefone")) onde.push(semCont ? "(e.telefone IS NOT NULL AND NOT coalesce(e.telefone_contador, false))" : "e.telefone IS NOT NULL");
  if (contatos.includes("celular")) onde.push(`(e.telefone ~ '^\\d{2}9\\d{8}$' OR e.telefone2 ~ '^\\d{2}9\\d{8}$')`);
  if (contatos.includes("fixo")) onde.push(`(e.telefone ~ '^\\d{2}[2-5]\\d{7}$' OR e.telefone2 ~ '^\\d{2}[2-5]\\d{7}$')`);
  if (contatos.includes("site")) onde.push(`EXISTS (SELECT 1 FROM fisco.pesquisa_web w WHERE w.cnpj = e.cnpj AND w.dados->>'site' IS NOT NULL AND (w.dados->>'mesma_empresa') IS DISTINCT FROM 'false')`);

  // Divida (federal) e momento da divida: EXISTS na mv_devedor
  const filtroDivida: Filtros = {
    valor_min: f.valor_min, valor_max: f.valor_max, tributo: f.tributo, ajuizada: f.ajuizada,
    acordo: f.acordo, sinal: f.sinal, programa: f.programa, estadual: f.estadual,
  };
  const temFiltroDivida = Object.values(filtroDivida).some((v) => v && String(v).length);
  if (f.divida === "sem") onde.push("NOT EXISTS (SELECT 1 FROM mv_devedor d WHERE d.cnpj_raiz = e.cnpj_raiz)");
  else if (f.divida === "com" || temFiltroDivida) {
    const m = montarFiltro(filtroDivida, p.length);
    p.push(...m.params);
    onde.push(`EXISTS (SELECT 1 FROM mv_devedor d WHERE d.cnpj_raiz = e.cnpj_raiz ${m.where ? "AND " + m.where.replace(/^WHERE /, "") : ""})`);
  }

  return { where: onde.length ? `WHERE ${onde.join(" AND ")}` : "", params: p };
}

const estadoCache = memo<any>(5 * 60_000);

export default async function rotasBusca(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  /** Tamanho da base e ultima carga, para a tela dizer o que esta pesquisando. */
  app.get("/api/busca/estado", auth, async () => estadoCache("e", async () => {
    const [b] = await q<any>(`SELECT
        (SELECT sum(reltuples)::bigint FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
          WHERE i.inhparent = 'fisco.estabelecimento'::regclass) AS estabelecimentos,
        (SELECT reltuples::bigint FROM pg_class WHERE oid = 'fisco.empresa_rfb'::regclass) AS empresas`);
    const cargas = await q(`SELECT periodo, etapa, status, terminou_em, inseridas, atualizadas, removidas
                              FROM rfb_carga ORDER BY periodo DESC, etapa LIMIT 10`);
    return { ...b, cargas, so_devedoras: !/^(false|0|no|nao|não)$/i.test(process.env.RECEITA_SO_DEVEDORAS ?? "") };
  }));

  /** Listas para os filtros: secoes, CNAEs (busca por texto), naturezas. */
  app.get<{ Querystring: { q?: string; ids?: string } }>("/api/busca/cnaes", auth, async (req) => {
    const ids = lista(req.query.ids).map((x) => x.replace(/\D/g, "")).filter((x) => x.length >= 2);
    if (ids.length) {
      // Prefixo (divisao/grupo/classe) ou codigo completo: devolve o rotulo de cada um.
      return q(`SELECT x.id AS codigo, coalesce(c.descricao, (SELECT descricao FROM cnae_ref WHERE codigo LIKE x.id || '%' ORDER BY codigo LIMIT 1)) AS descricao,
                       (length(x.id) < 7) AS prefixo
                  FROM unnest($1::text[]) AS x(id) LEFT JOIN cnae_ref c ON c.codigo = x.id`, [ids]);
    }
    const t = (req.query.q || "").trim();
    if (!t) return [];
    const digitos = t.replace(/\D/g, "");
    return q(`SELECT codigo, descricao, secao FROM cnae_ref
               WHERE ${digitos.length >= 2 ? "codigo LIKE $1 || '%'" : "descricao ILIKE '%' || $1 || '%'"}
               ORDER BY codigo LIMIT 30`, [digitos.length >= 2 ? digitos : t]);
  });
  app.get("/api/busca/referencias", auth, async () => ({
    secoes: Object.entries(SECOES).map(([codigo, descricao]) => ({ codigo, descricao })),
    naturezas: await q(`SELECT codigo, descricao, grupo FROM natureza_ref ORDER BY codigo`),
  }));

  /** Contagem rapida para a previa enquanto o usuario mexe nos filtros. */
  app.get<{ Querystring: FiltrosBusca }>("/api/busca/contagem", auth, async (req) => {
    const { where, params } = await montarBusca(req.query);
    const [c] = await q<{ n: string }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM estabelecimento e ${where} LIMIT ${TETO + 1}) x`, params);
    const n = Number(c?.n ?? 0);
    return { total: Math.min(n, TETO), excede: n > TETO };
  });

  app.get<{ Querystring: FiltrosBusca }>("/api/busca", auth, async (req) => {
    const { tenant } = sessao(req);
    const f = req.query;
    const { where, params } = await montarBusca(f);
    const ordem = ORDENS[f.ordem || ""] ?? ORDENS.contatos;
    const limite = numero(f.limite, 30, 1, 100);
    const pagina = numero(f.pagina, 1, 1, 3000);
    const raizPronta = await viewPronta("mv_raiz");
    const semCont = f.ocultar_contador === "1";
    const n = params.length;

    const [itens, [cont]] = await Promise.all([
      q(`SELECT e.cnpj, e.cnpj_raiz, e.razao_social, e.nome_fantasia, e.situacao, e.data_situacao, e.matriz,
                e.uf, e.municipio, e.municipio_ibge, e.bairro, e.cep, e.logradouro, e.numero, e.complemento,
                e.data_abertura, e.cnae_principal, c.descricao AS cnae_descricao, e.natureza_juridica,
                nr.descricao AS natureza, e.porte, e.capital_social, e.opcao_simples, e.opcao_mei,
                ${semCont ? "CASE WHEN coalesce(e.telefone_contador,false) THEN NULL ELSE e.telefone END" : "e.telefone"} AS telefone,
                e.telefone2,
                ${semCont ? "CASE WHEN coalesce(e.email_contador,false) THEN NULL ELSE e.email END" : "e.email"} AS email,
                e.email_contador, e.telefone_contador, e.pontos_contato,
                (SELECT json_build_object('valor_total', d.valor_total, 'qtd_inscricoes', d.qtd_inscricoes,
                        'tem_ajuizada', d.tem_ajuizada, 'tributo_principal', d.tributo_principal,
                        'qtd_rescindidas', d.qtd_rescindidas, 'qtd_negociadas', d.qtd_negociadas)
                   FROM mv_devedor d WHERE d.cnpj_raiz = e.cnpj_raiz) AS divida,
                (SELECT json_build_object('novas_tri', s.novas_tri, 'rescindidas_12m', s.rescindidas_12m,
                        'variacao_12m_pct', s.variacao_12m_pct)
                   FROM mv_devedor_sinais s WHERE s.cnpj_raiz = e.cnpj_raiz) AS sinais,
                (SELECT array_agg(nome) FROM (SELECT nome FROM socio so WHERE so.cnpj_raiz = e.cnpj_raiz
                   ORDER BY entrada NULLS LAST LIMIT 3) x) AS socios,
                ${raizPronta ? "(SELECT json_build_object('estab', r.qtd_estab, 'socios', r.qtd_socios) FROM mv_raiz r WHERE r.cnpj_raiz = e.cnpj_raiz)" : "NULL"} AS grupo,
                EXISTS (SELECT 1 FROM lead_juridico l WHERE l.tenant_id = $${n + 1} AND l.removido_em IS NULL
                         AND left(l.cnpj, 8) = e.cnpj_raiz) AS e_lead
           FROM estabelecimento e
           LEFT JOIN cnae_ref c ON c.codigo = e.cnae_principal
           LEFT JOIN natureza_ref nr ON nr.codigo = e.natureza_juridica
           ${where}
          ORDER BY ${ordem}, e.cnpj
          LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`, [...params, tenant]),
      q<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM estabelecimento e ${where} LIMIT ${TETO + 1}) x`, params),
    ]);
    const total = Number(cont?.n ?? 0);
    return { itens, total: Math.min(total, TETO), total_excede: total > TETO, pagina, limite };
  });
}
