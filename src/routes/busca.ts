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
  q?: string; email?: string; telefone?: string; cnpjs?: string; lista?: string;
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
export async function montarBusca(f: FiltrosBusca, tenant?: string) {
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
  // Lista importada: resolvida aqui (array de CNPJs) para o filtro usar a chave primaria.
  if (f.lista && tenant && /^[0-9a-f-]{36}$/i.test(f.lista)) {
    const [l] = await q<{ cnpjs: string[] }>(`SELECT cnpjs FROM lista_importada WHERE id = $1 AND tenant_id = $2`, [f.lista, tenant]);
    add("e.cnpj = ANY(?)", l?.cnpjs ?? []);
  }
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

/** Filtros que importam (sem pagina/limite/vazios), em ordem estavel. */
export function filtrosLimpos(f: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(f)
    .filter(([k, v]) => v != null && String(v) !== "" && !["pagina", "limite"].includes(k))
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, String(v)]));
}

async function registrarHistorico(req: any, f: FiltrosBusca, total: number, excede: boolean) {
  const { tenant, sub } = sessao(req);
  const filtros = filtrosLimpos(f as Record<string, unknown>);
  const so = Object.keys(filtros).filter((k) => k !== "ordem");
  if (!so.length || !sub) return;
  await q(`INSERT INTO busca_historico (tenant_id, usuario_id, chave, filtros, total, excede)
           VALUES ($1, $2, md5($3::text), $3::jsonb, $4, $5)
           ON CONFLICT (tenant_id, usuario_id, chave) DO UPDATE
             SET total = EXCLUDED.total, excede = EXCLUDED.excede, usado_em = now(), vezes = busca_historico.vezes + 1`,
    [tenant, sub, JSON.stringify(filtros), total, excede]).catch(() => {});
}

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

  /** Historico de pesquisas do usuario (cartoes). */
  app.get("/api/busca/historico", auth, async (req) => {
    const { tenant, sub } = sessao(req);
    return q(`SELECT chave, filtros, total, excede, vezes, criado_em, usado_em FROM busca_historico
               WHERE tenant_id = $1 AND usuario_id = $2 ORDER BY usado_em DESC LIMIT 60`, [tenant, sub]);
  });
  app.delete<{ Params: { chave: string } }>("/api/busca/historico/:chave", auth, async (req) => {
    const { tenant, sub } = sessao(req);
    await q(`DELETE FROM busca_historico WHERE tenant_id = $1 AND usuario_id = $2 AND chave = $3`, [tenant, sub, req.params.chave]);
    return { ok: true };
  });

  /** Contagem rapida para a previa enquanto o usuario mexe nos filtros. */
  app.get<{ Querystring: FiltrosBusca }>("/api/busca/contagem", auth, async (req) => {
    const { where, params } = await montarBusca(req.query, sessao(req).tenant);
    const [c] = await q<{ n: string }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM estabelecimento e ${where} LIMIT ${TETO + 1}) x`, params);
    const n = Number(c?.n ?? 0);
    return { total: Math.min(n, TETO), excede: n > TETO };
  });

  app.get<{ Querystring: FiltrosBusca }>("/api/busca", auth, async (req) => {
    const { tenant } = sessao(req);
    const f = req.query;
    const { where, params } = await montarBusca(f, sessao(req).tenant);
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
    if (pagina === 1) void registrarHistorico(req, f, Math.min(total, TETO), total > TETO);
    return { itens, total: Math.min(total, TETO), total_excede: total > TETO, pagina, limite };
  });

  /**
   * Graficos da pesquisa: ~20 agregados sobre o conjunto filtrado.
   * Conjunto grande (estimativa do planejador > 250 mil) usa amostra de
   * blocos (TABLESAMPLE) e escala as contagens: o desenho e o mesmo, e a
   * tela avisa que e estimativa. Uma consulta so, sobre um CTE materializado.
   */
  app.get<{ Querystring: FiltrosBusca }>("/api/busca/graficos", auth, async (req) => {
    const f = req.query;
    const { where, params } = await montarBusca(f, sessao(req).tenant);
    const [plano] = await q<any>(`EXPLAIN (FORMAT JSON) SELECT 1 FROM estabelecimento e ${where}`, params);
    const estimado = Number(plano?.["QUERY PLAN"]?.[0]?.Plan?.["Plan Rows"] ?? 0);
    const ALVO = 250_000;
    const pct = estimado > ALVO ? Math.max(0.05, Math.min(100, (ALVO / estimado) * 100)) : 100;
    const amostra = pct < 100 ? `TABLESAMPLE SYSTEM (${pct.toFixed(3)}) REPEATABLE (7)` : "";
    const fator = pct < 100 ? 100 / pct : 1;
    const raizPronta = await viewPronta("mv_raiz");
    const sinaisPronta = await viewPronta("mv_devedor_sinais");
    const k = (sql: string) => `(SELECT coalesce(json_agg(x), '[]') FROM (${sql}) x)`;
    const n = (expr = "count(*)") => `round(${expr} * ${fator})::bigint`;

    const [r] = await q<any>(`
      WITH base AS MATERIALIZED (
        SELECT e.cnpj_raiz, e.uf, e.municipio_ibge, e.municipio, e.bairro, e.situacao, e.data_situacao, e.matriz,
               e.data_abertura, e.cnae_principal, e.natureza_juridica, e.porte, e.capital_social,
               coalesce(e.opcao_mei, false) AS mei, coalesce(e.opcao_simples, false) AS simples,
               e.data_exclusao_simples, e.data_exclusao_mei,
               e.email IS NOT NULL AND NOT coalesce(e.email_contador, false) AS tem_email,
               e.telefone IS NOT NULL AS tem_tel,
               (e.telefone ~ '^\\d{2}9\\d{8}$' OR e.telefone2 ~ '^\\d{2}9\\d{8}$') AS tem_cel,
               d.valor_total AS divida, d.tem_ajuizada, d.qtd_rescindidas
          FROM estabelecimento e ${amostra}
          LEFT JOIN mv_devedor d ON d.cnpj_raiz = e.cnpj_raiz
          ${where}
        LIMIT 400000
      )
      SELECT
        ${n()} AS total,
        ${k(`SELECT uf AS chave, ${n()} AS n FROM base GROUP BY 1 ORDER BY 2 DESC`)} AS por_uf,
        ${k(`SELECT b.municipio_ibge AS ibge, max(b.municipio) || '/' || max(b.uf) AS chave, ${n()} AS n,
                    max(m.lat) AS lat, max(m.lon) AS lon, max(m.populacao) AS populacao,
                    CASE WHEN max(m.populacao) > 0 THEN round(${n()} * 1000.0 / max(m.populacao), 2) END AS por_mil
               FROM base b LEFT JOIN municipio_ref m ON m.municipio_ibge = b.municipio_ibge
              GROUP BY 1 ORDER BY 3 DESC LIMIT 400`)} AS por_municipio,
        ${k(`SELECT initcap(lower(bairro)) || ' · ' || max(municipio) AS chave, ${n()} AS n FROM base
              WHERE coalesce(bairro, '') <> '' GROUP BY bairro, municipio_ibge ORDER BY 2 DESC LIMIT 20`)} AS por_bairro,
        ${k(`SELECT c.secao AS chave, ${n()} AS n FROM base b JOIN cnae_ref c ON c.codigo = b.cnae_principal GROUP BY 1 ORDER BY 2 DESC`)} AS por_secao,
        ${k(`SELECT b.cnae_principal AS codigo, max(c.descricao) AS chave, ${n()} AS n FROM base b
               LEFT JOIN cnae_ref c ON c.codigo = b.cnae_principal GROUP BY 1 ORDER BY 3 DESC LIMIT 20`)} AS por_cnae,
        ${k(`SELECT CASE porte WHEN 1 THEN 'ME' WHEN 3 THEN 'EPP' WHEN 5 THEN 'Demais' ELSE 'Não informado' END AS chave, ${n()} AS n
               FROM base GROUP BY 1 ORDER BY 2 DESC`)} AS por_porte,
        ${k(`SELECT CASE WHEN mei THEN 'MEI' WHEN simples THEN 'Simples' ELSE 'Fora do Simples' END AS chave, ${n()} AS n
               FROM base GROUP BY 1 ORDER BY 2 DESC`)} AS por_regime,
        ${k(`SELECT coalesce(nr.grupo, 'outras') AS chave, ${n()} AS n FROM base b
               LEFT JOIN natureza_ref nr ON nr.codigo = b.natureza_juridica GROUP BY 1 ORDER BY 2 DESC`)} AS por_natureza,
        ${k(`SELECT CASE situacao WHEN 2 THEN 'Ativa' WHEN 8 THEN 'Baixada' WHEN 3 THEN 'Suspensa' WHEN 4 THEN 'Inapta' WHEN 1 THEN 'Nula' ELSE '?' END AS chave,
                    ${n()} AS n FROM base GROUP BY 1 ORDER BY 2 DESC`)} AS por_situacao,
        ${k(`SELECT CASE WHEN matriz THEN 'Matriz' ELSE 'Filial' END AS chave, ${n()} AS n FROM base GROUP BY 1 ORDER BY 2 DESC`)} AS por_tipo,
        ${k(`SELECT to_char(date_trunc('month', data_abertura), 'YYYY-MM') AS chave, ${n()} AS n FROM base
              WHERE data_abertura >= date_trunc('month', current_date) - interval '59 months' GROUP BY 1 ORDER BY 1`)} AS abertura_mes,
        ${k(`SELECT extract(year FROM data_abertura)::int AS chave, ${n()} AS n FROM base
              WHERE data_abertura IS NOT NULL GROUP BY 1 ORDER BY 1`)} AS abertura_ano,
        ${k(`SELECT to_char(date_trunc('month', data_situacao), 'YYYY-MM') AS chave, ${n()} AS n FROM base
              WHERE situacao = 8 AND data_situacao >= date_trunc('month', current_date) - interval '59 months' GROUP BY 1 ORDER BY 1`)} AS baixa_mes,
        ${k(`SELECT faixa AS chave, ${n()} AS n, min(ordem) AS ordem FROM (
               SELECT CASE WHEN idade < 1 THEN 'Menos de 1 ano' WHEN idade < 3 THEN '1 a 3 anos' WHEN idade < 5 THEN '3 a 5 anos'
                           WHEN idade < 10 THEN '5 a 10 anos' WHEN idade < 20 THEN '10 a 20 anos' ELSE '20 anos ou mais' END AS faixa,
                      CASE WHEN idade < 1 THEN 1 WHEN idade < 3 THEN 2 WHEN idade < 5 THEN 3 WHEN idade < 10 THEN 4 WHEN idade < 20 THEN 5 ELSE 6 END AS ordem
                 FROM (SELECT extract(year FROM age(current_date, data_abertura)) AS idade FROM base WHERE data_abertura IS NOT NULL) i) y
              GROUP BY 1 ORDER BY 3`)} AS por_idade,
        ${k(`SELECT faixa AS chave, ${n()} AS n, min(ordem) AS ordem FROM (
               SELECT CASE WHEN c IS NULL OR c = 0 THEN 'Não informado' WHEN c <= 10000 THEN 'Até R$ 10 mil' WHEN c <= 100000 THEN 'R$ 10 a 100 mil'
                           WHEN c <= 1000000 THEN 'R$ 100 mil a 1 mi' WHEN c <= 10000000 THEN 'R$ 1 a 10 mi' ELSE 'Acima de R$ 10 mi' END AS faixa,
                      CASE WHEN c IS NULL OR c = 0 THEN 9 WHEN c <= 10000 THEN 1 WHEN c <= 100000 THEN 2 WHEN c <= 1000000 THEN 3 WHEN c <= 10000000 THEN 4 ELSE 5 END AS ordem
                 FROM (SELECT capital_social AS c FROM base) i) y GROUP BY 1 ORDER BY 3`)} AS por_capital,
        json_build_object('email', ${n("count(*) FILTER (WHERE tem_email)")}, 'telefone', ${n("count(*) FILTER (WHERE tem_tel)")},
                          'celular', ${n("count(*) FILTER (WHERE tem_cel)")},
                          'nenhum', ${n("count(*) FILTER (WHERE NOT tem_email AND NOT tem_tel)")}) AS contato,
        json_build_object('com', ${n("count(*) FILTER (WHERE divida IS NOT NULL)")}, 'sem', ${n("count(*) FILTER (WHERE divida IS NULL)")},
                          'ajuizada', ${n("count(*) FILTER (WHERE tem_ajuizada)")}, 'acordo_caiu', ${n("count(*) FILTER (WHERE qtd_rescindidas > 0)")},
                          'valor', round(coalesce(sum(divida), 0) * ${fator})) AS divida,
        ${k(`SELECT faixa AS chave, ${n()} AS n, min(ordem) AS ordem FROM (
               SELECT CASE WHEN divida <= 10000 THEN 'Até R$ 10 mil' WHEN divida <= 100000 THEN 'R$ 10 a 100 mil' WHEN divida <= 1000000 THEN 'R$ 100 mil a 1 mi'
                           WHEN divida <= 10000000 THEN 'R$ 1 a 10 mi' ELSE 'Acima de R$ 10 mi' END AS faixa,
                      CASE WHEN divida <= 10000 THEN 1 WHEN divida <= 100000 THEN 2 WHEN divida <= 1000000 THEN 3 WHEN divida <= 10000000 THEN 4 ELSE 5 END AS ordem
                 FROM base WHERE divida IS NOT NULL) y GROUP BY 1 ORDER BY 3`)} AS por_faixa_divida,
        ${sinaisPronta ? `(SELECT json_build_object(
            'nova_tri', ${n("count(*) FILTER (WHERE s.novas_tri > 0)")}, 'nova_12m', ${n("count(*) FILTER (WHERE s.novas_12m > 0)")},
            'rescindiu', ${n("count(*) FILTER (WHERE s.rescindidas_12m > 0)")}, 'negociou', ${n("count(*) FILTER (WHERE s.negociadas_tri > 0)")},
            'cresceu', ${n("count(*) FILTER (WHERE s.variacao_12m_pct >= 10)")}, 'caiu', ${n("count(*) FILTER (WHERE s.variacao_12m_pct <= -10)")})
           FROM base b JOIN mv_devedor_sinais s ON s.cnpj_raiz = b.cnpj_raiz)` : "NULL"} AS sinais,
        ${raizPronta ? k(`SELECT faixa AS chave, ${n()} AS n, min(ordem) AS ordem FROM (
               SELECT CASE WHEN coalesce(r.qtd_socios, 0) = 0 THEN 'Sem sócio listado' WHEN r.qtd_socios = 1 THEN '1 sócio'
                           WHEN r.qtd_socios = 2 THEN '2 sócios' WHEN r.qtd_socios <= 5 THEN '3 a 5' ELSE '6 ou mais' END AS faixa,
                      CASE WHEN coalesce(r.qtd_socios, 0) = 0 THEN 9 WHEN r.qtd_socios = 1 THEN 1 WHEN r.qtd_socios = 2 THEN 2 WHEN r.qtd_socios <= 5 THEN 3 ELSE 4 END AS ordem
                 FROM base b LEFT JOIN mv_raiz r ON r.cnpj_raiz = b.cnpj_raiz) y GROUP BY 1 ORDER BY 3`) : "'[]'::json"} AS por_socios
      FROM base`, params);
    return { ...r, estimativa: pct < 100, amostra_pct: pct < 100 ? Number(pct.toFixed(2)) : 100, estimado_planejador: estimado };
  });

  /**
   * Ficha: o que a base completa sabe do estabelecimento (CNAEs
   * secundarios, motivo da situacao, datas de Simples/MEI) e todos os
   * estabelecimentos da mesma raiz (matriz e filiais).
   */
  app.get<{ Params: { cnpj: string } }>("/api/empresas/:cnpj/base", auth, async (req) => {
    const cnpj = req.params.cnpj.replace(/[^0-9A-Z]/gi, "").toUpperCase();
    const raiz = cnpj.slice(0, 8);
    const [estab] = await q<any>(
      `SELECT e.cnpj, e.matriz, e.situacao, e.data_situacao, e.motivo_situacao, ms.descricao AS motivo,
              e.situacao_especial, e.data_abertura, e.cnae_principal, e.cnae_secundarios,
              e.natureza_juridica, nr.descricao AS natureza, e.porte, e.capital_social,
              e.opcao_simples, e.data_opcao_simples, e.data_exclusao_simples,
              e.opcao_mei, e.data_opcao_mei, e.data_exclusao_mei, e.email_contador, e.telefone_contador, e.atualizado_em
         FROM estabelecimento e
         LEFT JOIN natureza_ref nr ON nr.codigo = e.natureza_juridica
         LEFT JOIN motivo_situacao_ref ms ON ms.codigo = e.motivo_situacao
        WHERE e.cnpj = $1`, [cnpj]).catch(() => []);
    const secundarios = estab?.cnae_secundarios?.length
      ? await q(`SELECT codigo, descricao FROM cnae_ref WHERE codigo = ANY($1) ORDER BY codigo`, [estab.cnae_secundarios]) : [];
    const filiais = await q(
      `SELECT e.cnpj, e.matriz, e.nome_fantasia, e.situacao, e.data_situacao, e.municipio, e.uf, e.bairro,
              e.data_abertura, e.telefone, e.email, e.cnae_principal
         FROM estabelecimento e WHERE e.cnpj_raiz = $1 ORDER BY e.matriz DESC, e.situacao = 2 DESC, e.uf, e.municipio LIMIT 500`, [raiz]);
    const [tot] = await q<{ n: string; ativos: string }>(
      `SELECT count(*) AS n, count(*) FILTER (WHERE situacao = 2) AS ativos FROM estabelecimento WHERE cnpj_raiz = $1`, [raiz]);
    return { estab: estab ?? null, secundarios, filiais, total_estab: Number(tot?.n ?? 0), ativos: Number(tot?.ativos ?? 0) };
  });
}
