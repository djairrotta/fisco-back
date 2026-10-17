-- =====================================================================
-- 025: mv_devedor ganha a situacao dos acordos de cada empresa:
--   qtd_rescindidas  inscricoes com parcelamento RESCINDIDO (o acordo caiu:
--                    divida exigivel de novo, prospect quente)
--   qtd_negociadas   inscricoes em acordo vigente (SISPAR, parcelamento,
--                    transacao, garantia, suspensao)
-- No 2o tri/2026 sao ~940 mil inscricoes rescindidas e ~860 mil negociadas
-- so nas bases FGTS e previdenciaria. Mesma guarda e WITH NO DATA da 022.
-- =====================================================================
SET search_path TO fisco, public;

DO $guarda$
BEGIN
  IF to_regclass('fisco.mv_devedor') IS NOT NULL AND EXISTS (
       SELECT 1 FROM pg_attribute WHERE attrelid = 'fisco.mv_devedor'::regclass AND attname = 'qtd_rescindidas') THEN
    RETURN;
  END IF;

  DROP MATERIALIZED VIEW IF EXISTS fisco.mv_devedor;

  EXECUTE $v$
    CREATE MATERIALIZED VIEW fisco.mv_devedor AS
    WITH d AS (
      SELECT
        i.cnpj_raiz,
        mode() WITHIN GROUP (ORDER BY i.uf)                AS uf,
        mode() WITHIN GROUP (ORDER BY i.nome_devedor)      AS nome,
        min(i.documento)                                   AS cnpj_pgfn,
        count(*)                                           AS qtd_inscricoes,
        sum(i.valor_consolidado)                           AS valor_total,
        coalesce(sum(i.valor_consolidado) FILTER (WHERE i.ajuizado), 0) AS valor_ajuizado,
        min(i.data_inscricao)                              AS inscricao_mais_antiga,
        max(i.data_inscricao)                              AS inscricao_mais_recente,
        max(i.data_referencia)                             AS data_referencia,
        mode() WITHIN GROUP (ORDER BY i.tributo)           AS tributo_principal,
        array_agg(DISTINCT i.tributo) FILTER (WHERE i.tributo IS NOT NULL) AS tributos,
        array_agg(DISTINCT i.origem::text)                 AS origens,
        coalesce(bool_or(i.ajuizado), false)               AS tem_ajuizada,
        count(*) FILTER (WHERE i.situacao ~* '(RESCIND|RESCISAO)')  AS qtd_rescindidas,
        count(*) FILTER (WHERE i.situacao !~* '(RESCIND|RESCISAO)'
                           AND i.situacao ~* '(NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSAC|SUSPENS|GARANTI|PENHORA REGULAR E SUFICIENTE)')
                                                           AS qtd_negociadas
      FROM fisco.divida_inscricao i
      WHERE i.tipo_pessoa = 'PJ' AND i.tipo_devedor = 1 AND i.cnpj_raiz IS NOT NULL
      GROUP BY i.cnpj_raiz
    ),
    soc AS (
      SELECT cnpj_raiz, count(*) AS qtd_socios FROM fisco.socio GROUP BY cnpj_raiz
    )
    SELECT DISTINCT ON (d.cnpj_raiz)
      d.*,
      coalesce(e.cnpj, d.cnpj_pgfn)   AS cnpj,
      e.nome_fantasia, e.situacao, e.data_abertura, e.cnae_principal,
      e.municipio_ibge, e.municipio,
      e.cep, e.logradouro, e.numero, e.bairro,
      nullif(e.telefone, '') AS telefone,
      nullif(e.email, '')    AS email,
      (e.cnpj IS NOT NULL)   AS tem_cadastro,
      r.porte, r.capital_social, r.natureza_juridica, r.opcao_simples, r.opcao_mei,
      CASE WHEN r.cnpj_raiz IS NULL THEN NULL
           WHEN r.opcao_mei THEN 'mei'
           WHEN r.opcao_simples THEN 'simples'
           ELSE 'demais' END   AS regime,
      s.qtd_socios,
      fisco.nome_chave(coalesce(d.nome, '') || ' ' || coalesce(e.nome_fantasia, '')
                       || ' ' || d.cnpj_raiz) AS busca
    FROM d
    LEFT JOIN fisco.estabelecimento e ON e.cnpj_raiz = d.cnpj_raiz AND e.matriz
    LEFT JOIN fisco.empresa_rfb r     ON r.cnpj_raiz = d.cnpj_raiz
    LEFT JOIN soc s                   ON s.cnpj_raiz = d.cnpj_raiz
    ORDER BY d.cnpj_raiz, e.atualizado_em DESC NULLS LAST
    WITH NO DATA
  $v$;

  CREATE UNIQUE INDEX ux_mv_devedor        ON fisco.mv_devedor (cnpj_raiz);
  CREATE INDEX ix_mv_devedor_valor          ON fisco.mv_devedor (valor_total DESC);
  CREATE INDEX ix_mv_devedor_uf_valor       ON fisco.mv_devedor (uf, valor_total DESC);
  CREATE INDEX ix_mv_devedor_mun            ON fisco.mv_devedor (municipio_ibge, valor_total DESC);
  CREATE INDEX ix_mv_devedor_busca          ON fisco.mv_devedor USING gin (busca gin_trgm_ops);
  CREATE INDEX ix_mv_devedor_tributos       ON fisco.mv_devedor USING gin (tributos);
  CREATE INDEX ix_mv_devedor_cnae           ON fisco.mv_devedor (cnae_principal);
  CREATE INDEX ix_mv_devedor_regime_porte   ON fisco.mv_devedor (regime, porte);
  CREATE INDEX ix_mv_devedor_rescindidas    ON fisco.mv_devedor (qtd_rescindidas) WHERE qtd_rescindidas > 0;
END $guarda$;
