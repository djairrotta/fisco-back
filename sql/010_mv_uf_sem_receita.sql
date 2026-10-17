-- =====================================================================
-- mv_uf deixa de depender da base da Receita.
--
-- DEFEITO QUE ISTO CORRIGE: mv_uf era derivada de mv_municipio, que
-- nasce de `estabelecimento` (base de CNPJ da Receita). Enquanto essa
-- base nao estivesse carregada, mv_uf vinha VAZIA -- o mapa da landing
-- mostrava zero mesmo com a divida da PGFN inteira no banco.
--
-- A PGFN ja publica UF. Entao o mapa por estado passa a sair direto da
-- divida, e so o recorte por MUNICIPIO continua dependendo da Receita,
-- que e a unica coisa que de fato exige o join. Municipio e contagem de
-- empresas ativas ficam em zero ate a Receita entrar, sem derrubar o
-- resto.
--
-- uf_valida() mantem o codigo 'SI' (e qualquer outro fora da lista)
-- fora do mapa, ainda que ele exista na tabela para auditoria.
-- =====================================================================
SET search_path TO fisco, public;

DROP MATERIALIZED VIEW IF EXISTS mv_uf;

CREATE MATERIALIZED VIEW mv_uf AS
WITH divida AS (
  SELECT uf,
         count(*)                 AS empresas_com_divida,
         sum(valor_total)         AS divida_total,
         max(data_referencia)     AS data_referencia
    FROM mv_divida_empresa
   WHERE uf_valida(uf)
   GROUP BY uf
),
cadastro AS (
  SELECT uf,
         count(DISTINCT municipio_ibge) AS municipios,
         count(*) FILTER (WHERE situacao = 2) AS empresas_ativas
    FROM estabelecimento
   WHERE matriz AND uf_valida(uf)
   GROUP BY uf
)
SELECT
  d.uf,
  coalesce(c.municipios, 0)       AS municipios,
  coalesce(c.empresas_ativas, 0)  AS empresas_ativas,
  d.empresas_com_divida,
  d.divida_total,
  d.data_referencia
FROM divida d
LEFT JOIN cadastro c USING (uf);

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_uf ON mv_uf (uf);
