-- =====================================================================
-- Views materializadas. O painel e a landing NUNCA leem a tabela bruta:
-- com dezenas de milhoes de linhas, so isto deixa o mapa instantaneo.
-- =====================================================================
SET search_path TO fisco, public;

-- Divida consolidada por empresa (so devedor principal — regra da PGFN)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_divida_empresa AS
SELECT
  d.cnpj_raiz,
  d.uf,
  count(*)                        AS qtd_inscricoes,
  sum(d.valor_consolidado)        AS valor_total,
  min(d.data_inscricao)           AS inscricao_mais_antiga,
  max(d.data_referencia)          AS data_referencia,
  mode() WITHIN GROUP (ORDER BY d.tributo) AS tributo_principal,
  array_agg(DISTINCT d.tributo)   AS tributos,
  array_agg(DISTINCT d.origem::text) AS origens
FROM divida_inscricao d
WHERE d.tipo_devedor = 1
GROUP BY d.cnpj_raiz, d.uf;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_div_emp ON mv_divida_empresa (cnpj_raiz, uf);

-- Agregado por municipio: alimenta o mapa do painel E as 5.570 paginas
-- publicas da landing. Mesma view, dois consumidores.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_municipio AS
SELECT
  e.uf,
  e.municipio_ibge,
  max(e.municipio)                                      AS municipio,
  count(*) FILTER (WHERE e.situacao = 2)                AS empresas_ativas,
  count(*) FILTER (WHERE e.situacao = 2 AND e.opcao_simples) AS qtd_simples,
  count(*) FILTER (WHERE e.situacao = 2 AND e.opcao_mei)     AS qtd_mei,
  count(DISTINCT v.cnpj_raiz)                           AS empresas_com_divida,
  coalesce(sum(v.valor_total), 0)                       AS divida_total,
  coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY v.valor_total), 0) AS divida_mediana,
  max(v.data_referencia)                                AS data_referencia
FROM estabelecimento e
LEFT JOIN mv_divida_empresa v
       ON v.cnpj_raiz = e.cnpj_raiz AND v.uf = e.uf
WHERE e.matriz
GROUP BY e.uf, e.municipio_ibge;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_mun ON mv_municipio (uf, municipio_ibge);

-- Distribuicao por tributo dentro do municipio (bloco da pagina publica)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_municipio_tributo AS
SELECT
  e.uf, e.municipio_ibge, d.tributo,
  count(DISTINCT d.cnpj_raiz) AS empresas,
  sum(d.valor_consolidado)    AS valor
FROM divida_inscricao d
JOIN estabelecimento e
  ON e.cnpj_raiz = d.cnpj_raiz AND e.uf = d.uf AND e.matriz
WHERE d.tipo_devedor = 1
GROUP BY e.uf, e.municipio_ibge, d.tributo;

CREATE INDEX IF NOT EXISTS ix_mv_mun_trib ON mv_municipio_tributo (uf, municipio_ibge);

-- Agregado por UF (indice da landing + topo do mapa)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_uf AS
SELECT
  uf,
  count(*)                     AS municipios,
  sum(empresas_ativas)         AS empresas_ativas,
  sum(empresas_com_divida)     AS empresas_com_divida,
  sum(divida_total)            AS divida_total,
  max(data_referencia)         AS data_referencia
FROM mv_municipio
GROUP BY uf;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_uf ON mv_uf (uf);
