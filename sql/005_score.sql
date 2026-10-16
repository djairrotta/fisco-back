-- =====================================================================
-- Motor de teses: elegibilidade em SQL puro.
-- Nenhuma LLM participa desta decisao. Tese derrotada multiplica por
-- zero e some do mapa sem precisar mexer em codigo.
-- =====================================================================
SET search_path TO fisco, public;

CREATE OR REPLACE FUNCTION score_tese(
  p_tese text,
  p_uf   char(2),
  p_municipio_ibge char(7) DEFAULT NULL
) RETURNS TABLE (
  cnpj             char(14),
  razao_social     text,
  municipio        text,
  porte            smallint,
  regime           text,
  divida_total     numeric,
  tributo_principal text,
  data_referencia  date,
  score            numeric
) LANGUAGE sql STABLE AS $$
  WITH t AS (SELECT * FROM tese WHERE slug = p_tese AND ativa)
  SELECT
    e.cnpj,
    e.razao_social,
    e.municipio,
    e.porte,
    CASE WHEN e.opcao_mei THEN 'MEI'
         WHEN e.opcao_simples THEN 'Simples Nacional'
         ELSE 'Lucro Presumido/Real' END AS regime,
    coalesce(v.valor_total, 0)  AS divida_total,
    v.tributo_principal,
    v.data_referencia,
    round((
        -- peso base da tese
        t.peso
        -- aderencia de CNAE
      + CASE WHEN t.cnae_incluidos IS NULL
               OR e.cnae_principal = ANY (t.cnae_incluidos) THEN 1.0 ELSE 0 END
        -- porte compativel
      + CASE WHEN t.portes IS NULL
               OR e.porte = ANY (t.portes) THEN 0.5 ELSE 0 END
        -- divida no tributo da tese reforca o lead
      + CASE WHEN v.cnpj_raiz IS NOT NULL
               AND (t.tributos_divida IS NULL
                    OR v.tributo_principal = ANY (t.tributos_divida)) THEN 1.5 ELSE 0 END
        -- porte economico como proxy de volume recuperavel
      + least(coalesce(v.valor_total, 0) / 1000000.0, 2.0)
    )
    -- maturidade e multiplicador: derrotada zera
    * CASE t.maturidade
        WHEN 'consolidada_favoravel' THEN 1.0
        WHEN 'modulada'              THEN 0.7
        WHEN 'em_disputa'            THEN 0.5
        WHEN 'derrotada'             THEN 0.0
      END, 2) AS score
  FROM t
  CROSS JOIN LATERAL (
    SELECT * FROM estabelecimento e2
    WHERE e2.uf = p_uf
      AND e2.situacao = 2
      AND e2.matriz
      AND (p_municipio_ibge IS NULL OR e2.municipio_ibge = p_municipio_ibge)
      AND (t.cnae_excluidos IS NULL OR NOT (e2.cnae_principal = ANY (t.cnae_excluidos)))
      AND (t.ufs IS NULL OR e2.uf = ANY (t.ufs))
      -- regime: o enum do produto so conhece tres; MEI nunca entra em
      -- tese que exige apuracao de PIS/COFINS
      AND (t.regimes IS NULL OR
           (CASE WHEN e2.opcao_mei THEN 'MEI'
                 WHEN e2.opcao_simples THEN 'Simples Nacional'
                 ELSE 'Lucro Presumido/Real' END) = ANY (t.regimes))
  ) e
  LEFT JOIN mv_divida_empresa v
         ON v.cnpj_raiz = e.cnpj_raiz AND v.uf = e.uf
  WHERE (NOT t.exige_divida OR v.cnpj_raiz IS NOT NULL)
    AND t.maturidade <> 'derrotada'
  ORDER BY score DESC
  LIMIT 500;
$$;
