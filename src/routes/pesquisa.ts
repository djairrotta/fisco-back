/**
 * Pesquisa de devedores, ficha da empresa, painel e cruzamentos.
 *
 * Tudo em cima da mv_devedor (uma linha por empresa). Enquanto ela nao
 * estiver preenchida -- primeiro boot depois do deploy, alguns minutos --
 * as rotas respondem 503 com `preparando: true` e a tela mostra isso, em
 * vez de uma lista vazia que pareceria "nenhuma empresa deve nada".
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { q } from "../db/pool.js";
import { consultarCadastro } from "../services/cadastro.js";
import {
  cnpjValido, limparCnpj, lista, memo, naoEncontrado, numero, raizValida, sessao,
} from "../lib/http.js";
import { viewPronta } from "../db/views-boot.js";

interface Filtros {
  q?: string; uf?: string | string[]; municipio?: string; valor_min?: string; valor_max?: string;
  tributo?: string | string[]; ajuizada?: string; contato?: string; cnae?: string;
  ativa?: string; desde?: string; ate?: string; ordem?: string; pagina?: string; limite?: string;
  cadastro?: string; regime?: string | string[]; porte?: string | string[];
  socios_min?: string; socios_max?: string; capital_min?: string; capital_max?: string;
}

const ORDENS: Record<string, string> = {
  valor_desc: "valor_total DESC",
  valor_asc: "valor_total ASC",
  nome: "nome ASC",
  antigas: "inscricao_mais_antiga ASC NULLS LAST",
  recentes: "inscricao_mais_recente DESC NULLS LAST",
  inscricoes: "qtd_inscricoes DESC",
  ajuizado: "valor_ajuizado DESC",
  capital: "capital_social DESC NULLS LAST",
  socios: "qtd_socios DESC NULLS LAST",
};

/** Monta o WHERE com parametros posicionais. Exportado para teste. */
export function montarFiltro(f: Filtros) {
  const onde: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); onde.push(sql.replace("?", `$${p.length}`)); };

  const texto = (f.q || "").trim();
  if (texto) {
    // So vira busca por CNPJ quando e numero puro (8 a 14 digitos) ou um
    // CNPJ alfanumerico completo. "Padaria 2000" continua busca por nome.
    const compacto = texto.replace(/[\s./-]/g, "").toUpperCase();
    if (/^\d{8,14}$/.test(compacto) || /^[0-9A-Z]{12}\d{2}$/.test(compacto) && /\d/.test(compacto.slice(0, 8))) {
      add("cnpj_raiz = ?", compacto.slice(0, 8));
    } else {
      add("busca LIKE '%' || nome_chave(?) || '%'", texto);
    }
  }
  const ufs = lista(f.uf).map((u) => u.toUpperCase()).filter((u) => /^[A-Z]{2}$/.test(u));
  if (ufs.length) add("uf = ANY(?)", ufs);
  // Uma cidade ou varias (codigos IBGE separados por virgula).
  const municipios = lista(f.municipio).filter((m) => /^\d{7}$/.test(m));
  if (municipios.length) add("municipio_ibge = ANY(?)", municipios);
  // Regime como a Receita publica: MEI, Simples ou fora do Simples.
  const regimes = lista(f.regime).filter((r) => ["mei", "simples", "demais"].includes(r));
  if (regimes.length) add("regime = ANY(?)", regimes);
  // Porte: 1 ME, 3 EPP, 5 demais.
  const portes = lista(f.porte).filter((x) => ["1", "3", "5"].includes(x)).map(Number);
  if (portes.length) add("porte = ANY(?::smallint[])", portes);
  if (f.socios_min && Number(f.socios_min) > 0) add("qtd_socios >= ?", Number(f.socios_min));
  if (f.socios_max && Number(f.socios_max) > 0) add("qtd_socios <= ?", Number(f.socios_max));
  if (f.capital_min && Number(f.capital_min) > 0) add("capital_social >= ?", Number(f.capital_min));
  if (f.capital_max && Number(f.capital_max) > 0) add("capital_social <= ?", Number(f.capital_max));
  if (f.valor_min && Number(f.valor_min) > 0) add("valor_total >= ?", Number(f.valor_min));
  if (f.valor_max && Number(f.valor_max) > 0) add("valor_total <= ?", Number(f.valor_max));
  const tributos = lista(f.tributo);
  if (tributos.length) add("tributos && ?::text[]", tributos);
  if (f.ajuizada === "sim") onde.push("tem_ajuizada");
  if (f.ajuizada === "nao") onde.push("NOT tem_ajuizada");
  if (f.contato === "telefone") onde.push("telefone IS NOT NULL");
  if (f.contato === "email") onde.push("email IS NOT NULL");
  if (f.contato === "qualquer") onde.push("(telefone IS NOT NULL OR email IS NOT NULL)");
  if (f.cadastro === "sim") onde.push("tem_cadastro");
  if (f.cnae && /^\d{2,7}$/.test(f.cnae)) add("cnae_principal LIKE ? || '%'", f.cnae);
  if (f.ativa === "sim") onde.push("situacao = 2");
  if (f.desde && /^\d{4}$/.test(f.desde)) add("inscricao_mais_antiga >= make_date(?::int, 1, 1)", Number(f.desde));
  if (f.ate && /^\d{4}$/.test(f.ate)) add("inscricao_mais_antiga < make_date(?::int + 1, 1, 1)", Number(f.ate));

  return { where: onde.length ? `WHERE ${onde.join(" AND ")}` : "", params: p };
}

const COLUNAS_LISTA = `cnpj_raiz, cnpj, nome, nome_fantasia, uf, municipio, municipio_ibge,
  qtd_inscricoes, valor_total, valor_ajuizado, tem_ajuizada, tributo_principal, tributos,
  inscricao_mais_antiga, data_referencia, telefone, email, cnae_principal, situacao, tem_cadastro,
  porte, regime, qtd_socios, capital_social`;

const LIMITE_CONTAGEM = 100_000;

async function preparando(reply: FastifyReply): Promise<boolean> {
  if (await viewPronta("mv_devedor")) return false;
  reply.code(503).send({
    preparando: true,
    erro: "A base de pesquisa está sendo montada depois da atualização. Leva alguns minutos.",
  });
  return true;
}

const painelCache = memo<any>(30 * 60_000);

export default async function rotasPesquisa(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  // ------------------------------------------------------------------
  // Pesquisa
  // ------------------------------------------------------------------
  app.get<{ Querystring: Filtros }>("/api/devedores", auth, async (req, reply) => {
    if (await preparando(reply)) return;
    const { tenant } = sessao(req);
    const f = req.query;
    const { where, params } = montarFiltro(f);
    const ordem = ORDENS[f.ordem || ""] ?? ORDENS.valor_desc;
    const limite = numero(f.limite, 50, 1, 100);
    const pagina = numero(f.pagina, 1, 1, 2000);

    const [linhas, [cont]] = await Promise.all([
      q(`SELECT ${COLUNAS_LISTA},
                EXISTS (SELECT 1 FROM lead_juridico l
                         WHERE l.tenant_id = $${params.length + 1} AND l.removido_em IS NULL
                           AND left(l.cnpj, 8) = d.cnpj_raiz) AS e_lead
           FROM mv_devedor d ${where}
          ORDER BY ${ordem}, cnpj_raiz
          LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`, [...params, tenant]),
      // Contagem com teto: contar 4 milhoes de linhas a cada pagina e caro
      // e ninguem precisa saber se sao 3.981.442 ou "mais de 100 mil".
      q<{ n: string; soma: string }>(
        `SELECT count(*) AS n, sum(valor_total) AS soma FROM (
           SELECT valor_total FROM mv_devedor ${where} LIMIT ${LIMITE_CONTAGEM + 1}) x`, params),
    ]);
    const n = Number(cont?.n ?? 0);
    return {
      itens: linhas,
      total: Math.min(n, LIMITE_CONTAGEM),
      total_excede: n > LIMITE_CONTAGEM,
      soma_valor: n > LIMITE_CONTAGEM ? null : Number(cont?.soma ?? 0),
      pagina, limite,
    };
  });

  // Exportacao CSV, ate 5 mil linhas por vez.
  app.get<{ Querystring: Filtros }>("/api/devedores.csv", auth, async (req, reply) => {
    if (await preparando(reply)) return;
    const { where, params } = montarFiltro(req.query);
    const ordem = ORDENS[req.query.ordem || ""] ?? ORDENS.valor_desc;
    const linhas = await q<any>(
      `SELECT cnpj, nome, nome_fantasia, uf, municipio, valor_total, valor_ajuizado,
              qtd_inscricoes, tributo_principal, inscricao_mais_antiga, telefone, email,
              cnae_principal, data_referencia, regime, porte, qtd_socios, capital_social
         FROM mv_devedor ${where} ORDER BY ${ordem} LIMIT 5000`, params);
    const cab = ["CNPJ", "Razão social", "Nome fantasia", "UF", "Município", "Dívida total",
      "Dívida ajuizada", "Inscrições", "Tributo principal", "Inscrição mais antiga",
      "Telefone", "E-mail", "CNAE", "Posição da base", "Regime", "Porte", "Sócios", "Capital social"];
    const esc = (v: unknown) => {
      if (v == null) return "";
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const corpo = [cab.join(";"), ...linhas.map((l) => [
      l.cnpj, l.nome, l.nome_fantasia, l.uf, l.municipio,
      String(l.valor_total).replace(".", ","), String(l.valor_ajuizado).replace(".", ","),
      l.qtd_inscricoes, l.tributo_principal, l.inscricao_mais_antiga, l.telefone, l.email,
      l.cnae_principal, l.data_referencia,
      ({ mei: "MEI", simples: "Simples Nacional", demais: "Fora do Simples" } as Record<string, string>)[l.regime] ?? "",
      ({ 1: "ME", 3: "EPP", 5: "Demais" } as Record<number, string>)[l.porte] ?? "",
      l.qtd_socios, l.capital_social == null ? "" : String(l.capital_social).replace(".", ","),
    ].map(esc).join(";"))].join("\r\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="devedores-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM: sem ele o Excel em portugues abre o UTF-8 como Latin-1.
    return "﻿" + corpo;
  });

  // Municipios para o filtro (autocompletar e nomes dos ja escolhidos).
  app.get<{ Querystring: { q?: string; uf?: string; ids?: string } }>("/api/municipios", auth, async (req) => {
    const todos = await listaMunicipios();
    const ids = lista(req.query.ids);
    if (ids.length) return todos.filter((m) => ids.includes(m.ibge)).map(({ chave, ...m }) => m);
    const t = chaveSimples(req.query.q || "");
    const uf = (req.query.uf || "").toUpperCase();
    if (t.length < 2 && !uf) return [];
    return todos
      .filter((m) => (!uf || m.uf === uf) && (!t || m.chave.includes(t)))
      .sort((a, b) => Number(!a.chave.startsWith(t)) - Number(!b.chave.startsWith(t)) || a.nome.localeCompare(b.nome))
      .slice(0, 30)
      .map(({ chave, ...m }) => m);
  });

  // Tributos existentes, para o filtro.
  app.get("/api/devedores/tributos", auth, async () =>
    painelCache("tributos", () => q(
      `SELECT tributo, count(*) AS empresas FROM (
         SELECT unnest(tributos) AS tributo FROM mv_devedor) x
        GROUP BY tributo ORDER BY empresas DESC LIMIT 60`)).catch(() => []));

  // ------------------------------------------------------------------
  // Painel
  // ------------------------------------------------------------------
  app.get<{ Querystring: { uf?: string } }>("/api/painel", auth, async (req, reply) => {
    if (await preparando(reply)) return;
    const uf = (req.query.uf || "").toUpperCase();
    const filtroUf = /^[A-Z]{2}$/.test(uf) ? uf : "";
    return painelCache(`painel:${filtroUf}`, () => montarPainel(filtroUf));
  });

  // ------------------------------------------------------------------
  // Ficha da empresa
  // ------------------------------------------------------------------
  app.get<{ Params: { cnpj: string } }>("/api/empresas/:cnpj", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const doc = limparCnpj(req.params.cnpj);
    const raiz = doc.slice(0, 8);
    if (!raizValida(raiz)) return reply.code(400).send({ erro: "CNPJ inválido." });

    const pronta = await viewPronta("mv_devedor");
    const [devedor] = pronta
      ? await q<any>(`SELECT * FROM mv_devedor WHERE cnpj_raiz = $1`, [raiz])
      : [null];
    const cnpj = cnpjValido(doc) ? doc : devedor?.cnpj ?? null;

    const [inscricoes, sociosDevedores, lead, notas, cadastro] = await Promise.all([
      q(`SELECT numero_inscricao, origem, tributo, receita_principal, situacao, tipo_situacao,
                valor_consolidado, data_inscricao, ajuizado, tipo_devedor, documento,
                unidade_origem, data_referencia
           FROM divida_inscricao WHERE cnpj_raiz = $1
          ORDER BY valor_consolidado DESC LIMIT 300`, [raiz]),
      q(`SELECT nome, uf, documento, valor_total, qtd_inscricoes, tem_ajuizada,
                candidatos, confianca, qualificacao, empresas
           FROM mv_socio_devedor WHERE cnpj_raiz = $1 ORDER BY valor_total DESC`, [raiz])
        .catch(() => []),
      q(`SELECT id, fase, nome, criado_em FROM lead_juridico
          WHERE tenant_id = $1 AND left(cnpj, 8) = $2 AND removido_em IS NULL LIMIT 1`, [tenant, raiz]),
      q(`SELECT id, titulo, icone, atualizado_em FROM nota
          WHERE tenant_id = $1 AND left(cnpj, 8) = $2 AND removido_em IS NULL
          ORDER BY atualizado_em DESC`, [tenant, raiz]),
      cnpj ? consultarCadastro(cnpj).catch(() => null) : Promise.resolve(null),
    ]);

    if (!devedor && !inscricoes.length && !cadastro) return naoEncontrado(reply, "empresa");

    const grupo = await grupoEconomico(raiz).catch(() => []);
    return {
      raiz, cnpj, devedor, inscricoes, cadastro, socios_devedores: sociosDevedores,
      grupo_economico: grupo, lead: lead[0] ?? null, notas,
      avisos: {
        socios: "Vínculo entre sócio e dívida de pessoa física é inferido por fragmento de CPF "
          + "mais nome (PGFN e Receita mascaram o CPF). É indício, não identificação.",
        contatos: "Telefone e e-mail são os declarados no cadastro da Receita. Muitas vezes são "
          + "do contador que registrou a empresa.",
      },
    };
  });

  /** Reconsulta o cadastro na fonte externa (botao "atualizar"). */
  app.post<{ Params: { cnpj: string } }>("/api/empresas/:cnpj/cadastro", auth, async (req, reply) => {
    const cnpj = limparCnpj(req.params.cnpj);
    if (!cnpjValido(cnpj)) return reply.code(400).send({ erro: "CNPJ inválido." });
    const c = await consultarCadastro(cnpj, true);
    if (!c) return reply.code(502).send({ erro: "Nenhuma fonte de cadastro respondeu agora. Tente em instantes." });
    return c;
  });

  // ------------------------------------------------------------------
  // Cruzamentos
  // ------------------------------------------------------------------
  app.get<{ Querystring: { tipo?: string; uf?: string } }>("/api/cruzamentos", auth, async (req, reply) => {
    const uf = (req.query.uf || "").toUpperCase();
    const filtroUf = /^[A-Z]{2}$/.test(uf) ? uf : "";
    const tipo = req.query.tipo === "grupos" ? "grupos" : "socios";
    const temSocios = await q<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM socio LIMIT 1) x`);
    if (Number(temSocios[0]?.n) === 0) {
      return { tipo, itens: [], sem_base: true,
        aviso: "O quadro societário da Receita ainda não foi carregado. Os cruzamentos aparecem depois da primeira carga mensal de sócios." };
    }
    if (await preparando(reply)) return;
    return painelCache(`cruz:${tipo}:${filtroUf}`, async () => ({
      tipo,
      itens: tipo === "socios" ? await cruzarSocios(filtroUf) : await cruzarGrupos(filtroUf),
      aviso: "Vínculos inferidos por fragmento de CPF e nome. Confirme antes de agir.",
    }));
  });

  // ------------------------------------------------------------------
  // Pesquisas salvas
  // ------------------------------------------------------------------
  app.get("/api/buscas", auth, async (req) =>
    q(`SELECT id, nome, filtros, criado_em FROM busca_salva WHERE tenant_id = $1 ORDER BY criado_em DESC`,
      [sessao(req).tenant]));

  app.post<{ Body: { nome?: string; filtros?: unknown } }>("/api/buscas", auth, async (req, reply) => {
    const nome = (req.body?.nome || "").trim().slice(0, 120);
    if (!nome || typeof req.body?.filtros !== "object") return reply.code(400).send({ erro: "Informe nome e filtros." });
    const [b] = await q(`INSERT INTO busca_salva (tenant_id, nome, filtros) VALUES ($1,$2,$3) RETURNING *`,
      [sessao(req).tenant, nome, JSON.stringify(req.body.filtros)]);
    return reply.code(201).send(b);
  });

  app.delete<{ Params: { id: string } }>("/api/buscas/:id", auth, async (req) => {
    await q(`DELETE FROM busca_salva WHERE id = $1 AND tenant_id = $2`, [req.params.id, sessao(req).tenant]);
    return { ok: true };
  });
}

// ----------------------------------------------------------------------
// Consultas pesadas, isoladas para leitura
// ----------------------------------------------------------------------

async function montarPainel(uf: string) {
  const w = uf ? "WHERE uf = $1" : "";
  const p = uf ? [uf] : [];
  const [totais] = await q<any>(
    `SELECT count(*) AS empresas, coalesce(sum(valor_total),0) AS valor_total,
            coalesce(sum(valor_ajuizado),0) AS valor_ajuizado,
            count(*) FILTER (WHERE tem_ajuizada) AS empresas_ajuizadas,
            coalesce(sum(qtd_inscricoes),0) AS inscricoes,
            count(*) FILTER (WHERE tem_cadastro) AS com_cadastro,
            count(*) FILTER (WHERE telefone IS NOT NULL OR email IS NOT NULL) AS com_contato,
            max(data_referencia) AS data_referencia
       FROM mv_devedor ${w}`, p);

  const [porUf, porTributo, faixas, porAno, topMunicipios, topDevedores, pessoas, porRegime, porPorte] = await Promise.all([
    q(`SELECT uf, count(*) AS empresas, sum(valor_total) AS valor_total,
              sum(valor_ajuizado) AS valor_ajuizado
         FROM mv_devedor GROUP BY uf ORDER BY valor_total DESC`),
    q(`SELECT tributo_principal AS tributo, count(*) AS empresas, sum(valor_total) AS valor_total
         FROM mv_devedor ${w} GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 12`, p),
    q(`SELECT faixa, ordem, count(*) AS empresas, sum(valor_total) AS valor_total FROM (
         SELECT valor_total, CASE
           WHEN valor_total < 10000      THEN 'até 10 mil'
           WHEN valor_total < 50000      THEN '10 a 50 mil'
           WHEN valor_total < 100000     THEN '50 a 100 mil'
           WHEN valor_total < 500000     THEN '100 a 500 mil'
           WHEN valor_total < 1000000    THEN '500 mil a 1 mi'
           WHEN valor_total < 5000000    THEN '1 a 5 mi'
           WHEN valor_total < 50000000   THEN '5 a 50 mi'
           ELSE 'acima de 50 mi' END AS faixa,
         CASE
           WHEN valor_total < 10000 THEN 1 WHEN valor_total < 50000 THEN 2
           WHEN valor_total < 100000 THEN 3 WHEN valor_total < 500000 THEN 4
           WHEN valor_total < 1000000 THEN 5 WHEN valor_total < 5000000 THEN 6
           WHEN valor_total < 50000000 THEN 7 ELSE 8 END AS ordem
         FROM mv_devedor ${w}) x GROUP BY faixa, ordem ORDER BY ordem`, p),
    q(`SELECT extract(year FROM inscricao_mais_antiga)::int AS ano, count(*) AS empresas,
              sum(valor_total) AS valor_total
         FROM mv_devedor ${w ? w + " AND" : "WHERE"} inscricao_mais_antiga >= make_date(extract(year FROM now())::int - 25, 1, 1)
        GROUP BY 1 ORDER BY 1`, p),
    q(`SELECT municipio_ibge, municipio, uf, count(*) AS empresas, sum(valor_total) AS valor_total
         FROM mv_devedor ${w ? w + " AND" : "WHERE"} municipio_ibge IS NOT NULL
        GROUP BY 1,2,3 ORDER BY valor_total DESC LIMIT 15`, p),
    q(`SELECT cnpj_raiz, cnpj, nome, uf, municipio, valor_total, tem_ajuizada, tributo_principal
         FROM mv_devedor ${w} ORDER BY valor_total DESC LIMIT 10`, p),
    q(`SELECT count(*) AS pessoas, coalesce(sum(valor_total),0) AS valor_total
         FROM mv_divida_pessoa ${w}`, p).catch(() => [{ pessoas: 0, valor_total: 0 }]),
    q(`SELECT regime, count(*) AS empresas, sum(valor_total) AS valor_total
         FROM mv_devedor ${w ? w + " AND" : "WHERE"} regime IS NOT NULL GROUP BY regime ORDER BY 2 DESC`, p),
    q(`SELECT porte, count(*) AS empresas, sum(valor_total) AS valor_total
         FROM mv_devedor ${w ? w + " AND" : "WHERE"} porte IN (1,3,5) GROUP BY porte ORDER BY porte`, p),
  ]);

  return {
    uf: uf || null, totais, por_uf: porUf, por_tributo: porTributo, faixas,
    por_ano: porAno, top_municipios: topMunicipios, top_devedores: topDevedores,
    pessoas_fisicas: pessoas[0], por_regime: porRegime, por_porte: porPorte,
    gerado_em: new Date().toISOString(),
  };
}

/** Empresas devedoras cujos socios tambem devem como pessoa fisica. */
async function cruzarSocios(uf: string) {
  return q(
    `SELECT d.cnpj_raiz, d.cnpj, d.nome, d.uf, d.municipio, d.valor_total AS divida_empresa,
            count(*) AS socios_devedores, sum(s.valor_total) AS divida_socios,
            d.valor_total + sum(s.valor_total) AS exposicao_total,
            bool_and(s.confianca = 'alta') AS todos_alta,
            array_agg(s.nome ORDER BY s.valor_total DESC) AS nomes
       FROM mv_socio_devedor s
       JOIN mv_devedor d ON d.cnpj_raiz = s.cnpj_raiz
      ${uf ? "WHERE d.uf = $1" : ""}
      GROUP BY d.cnpj_raiz, d.cnpj, d.nome, d.uf, d.municipio, d.valor_total
      ORDER BY exposicao_total DESC LIMIT 200`, uf ? [uf] : []);
}

/**
 * Grupo economico de fato: a mesma pessoa (nome + fragmento do CPF) como
 * socia de duas ou mais empresas devedoras.
 */
async function cruzarGrupos(uf: string) {
  return q(
    `WITH s AS (
       SELECT nome_chave(s.nome) AS chave, min(s.nome) AS nome, s.fragmento,
              array_agg(DISTINCT s.cnpj_raiz) AS raizes
         FROM socio s
         JOIN mv_devedor d ON d.cnpj_raiz = s.cnpj_raiz ${uf ? "AND d.uf = $1" : ""}
        WHERE s.tipo = 'PF' AND s.fragmento IS NOT NULL
        GROUP BY 1, 3
       HAVING count(DISTINCT s.cnpj_raiz) >= 2
     )
     SELECT s.nome, s.fragmento, cardinality(s.raizes) AS empresas,
            sum(d.valor_total) AS divida_total,
            json_agg(json_build_object('cnpj_raiz', d.cnpj_raiz, 'nome', d.nome,
                     'uf', d.uf, 'valor_total', d.valor_total) ORDER BY d.valor_total DESC) AS lista
       FROM s JOIN mv_devedor d ON d.cnpj_raiz = ANY(s.raizes)
      GROUP BY s.nome, s.fragmento, s.raizes
      ORDER BY divida_total DESC LIMIT 200`, uf ? [uf] : []);
}

/** Outras empresas devedoras com socio em comum com esta. */
async function grupoEconomico(raiz: string) {
  return q(
    `WITH meus AS (
       SELECT nome_chave(nome) AS chave, fragmento, nome FROM socio
        WHERE cnpj_raiz = $1 AND tipo = 'PF' AND fragmento IS NOT NULL
     )
     SELECT d.cnpj_raiz, d.cnpj, d.nome, d.uf, d.municipio, d.valor_total,
            array_agg(DISTINCT m.nome) AS socios_em_comum
       FROM meus m
       JOIN socio s ON s.fragmento = m.fragmento AND nome_chave(s.nome) = m.chave
                   AND s.cnpj_raiz <> $1
       JOIN mv_devedor d ON d.cnpj_raiz = s.cnpj_raiz
      GROUP BY d.cnpj_raiz, d.cnpj, d.nome, d.uf, d.municipio, d.valor_total
      ORDER BY d.valor_total DESC LIMIT 50`, [raiz]);
}

/**
 * Calcula o painel nacional logo depois do boot. Sem isto o primeiro
 * advogado do dia espera os agregados de 4 milhoes de empresas.
 */
export async function aquecerPainel() {
  if (!(await viewPronta("mv_devedor"))) return;
  const t = Date.now();
  await painelCache("painel:", () => montarPainel("")).catch(() => {});
  console.log(`[painel] aquecido em ${Math.round((Date.now() - t) / 1000)}s`);
}

// ----------------------------------------------------------------------
// Municipios do IBGE, uma vez por processo. Se o IBGE nao responder, cai
// no que a base ja conhece (cidades das empresas carregadas).
// ----------------------------------------------------------------------
interface Mun { ibge: string; nome: string; uf: string; chave: string }
let municipios: Promise<Mun[]> | null = null;
const chaveSimples = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

function listaMunicipios(): Promise<Mun[]> {
  municipios ??= (async () => {
    try {
      const r = await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/municipios");
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as any[];
      return j.map((x) => {
        const uf = x?.microrregiao?.mesorregiao?.UF?.sigla ?? x?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla ?? "";
        return { ibge: String(x.id), nome: x.nome, uf, chave: chaveSimples(x.nome) };
      });
    } catch {
      municipios = null;   // tenta de novo na proxima chamada
      const rows = await q<{ ibge: string; nome: string; uf: string }>(
        `SELECT DISTINCT municipio_ibge AS ibge, municipio AS nome, uf FROM estabelecimento
          WHERE municipio_ibge IS NOT NULL`).catch(() => []);
      return rows.map((m) => ({ ...m, chave: chaveSimples(m.nome) }));
    }
  })();
  return municipios;
}
