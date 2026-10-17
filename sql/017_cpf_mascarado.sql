-- =====================================================================
-- A PGFN MASCARA O CPF. Isso muda o modelo de pessoa física.
--
-- O que o arquivo publica para PF:   XXX878.325XX
-- O que publica para PJ:             10.496.760/0001-95
--
-- Só os 6 dígitos do meio do CPF saem. Os 3 primeiros e os 2
-- verificadores são ocultados (prática de proteção de dados que a
-- própria PGFN adota, e que o Estado de MG replica na Resolução
-- Conjunta SEF/AGE 5.625/2022).
--
-- CONSEQUÊNCIAS, e elas são do produto, não do banco:
--  1. NÃO dá para identificar a pessoa com certeza. 6 dígitos mais nome
--     não é chave única: homônimo com fragmento igual é indistinguível.
--  2. NÃO dá para enriquecer por CPF. APIBrasil e Infosimples exigem o
--     CPF completo.
--  3. NÃO dá para deduplicar com segurança. No arquivo do FGTS,
--     'LINO MARTINS PINTO' aparece duas vezes com o mesmo fragmento:
--     pode ser a mesma pessoa com duas inscrições, ou duas pessoas.
--
-- Por isso `documento` guarda o valor PUBLICADO, com as máscaras, em vez
-- dos 6 dígitos soltos. Uma coluna com 'XXX878.325XX' ninguém confunde
-- com CPF nem tenta usar como chave de join; uma com '878325' alguém
-- tentaria.
-- =====================================================================
SET search_path TO fisco, public;

ALTER TABLE divida_inscricao DROP CONSTRAINT IF EXISTS ck_documento;
ALTER TABLE divida_inscricao ADD CONSTRAINT ck_documento CHECK (
  (tipo_pessoa = 'PJ' AND documento ~ '^[0-9]{14}$' AND cnpj_raiz IS NOT NULL) OR
  (tipo_pessoa = 'PF' AND cnpj_raiz IS NULL)
) NOT VALID;

ALTER TABLE divida_inscricao
  ADD COLUMN IF NOT EXISTS documento_completo boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN divida_inscricao.documento_completo IS
  'false quando a origem mascarou o documento (sempre o caso de CPF na PGFN)';

-- A chave de agregação de PF é o melhor disponível, e ainda assim é
-- aproximada: fragmento + nome + UF. Está documentado como aproximação
-- para ninguém tratar a contagem de pessoas como exata.
-- O DROP ... CASCADE acima derruba mv_uf junto, porque ela depende de
-- mv_divida_pessoa. Recriar aqui NAO e opcional: sem isto a migracao
-- deixa o mapa sem a view que a landing inteira consome.

-- GUARDA (021): o DROP ... CASCADE abaixo derrubava mv_divida_pessoa, mv_uf e
-- mv_socio_devedor a cada boot. So roda quando a versao desta migracao
-- ainda nao existe (o indice ix_mv_div_pes_nome e criado so aqui).
DO $guarda$
BEGIN
  IF to_regclass('fisco.ix_mv_div_pes_nome') IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE $v$DROP MATERIALIZED VIEW IF EXISTS mv_divida_pessoa CASCADE$v$;
  EXECUTE $v$CREATE MATERIALIZED VIEW mv_divida_pessoa AS
SELECT
  d.documento, d.nome_devedor AS nome, d.uf,
  count(*)                                AS qtd_inscricoes,
  sum(d.valor_consolidado)                AS valor_total,
  min(d.data_inscricao)                   AS inscricao_mais_antiga,
  max(d.data_referencia)                  AS data_referencia,
  mode() WITHIN GROUP (ORDER BY d.tributo) AS tributo_principal,
  bool_or(d.ajuizado)                     AS tem_ajuizada
FROM divida_inscricao d
WHERE d.tipo_devedor = 1 AND d.tipo_pessoa = 'PF'
GROUP BY d.documento, d.nome_devedor, d.uf$v$;
  EXECUTE $v$CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_div_pes
  ON mv_divida_pessoa (documento, nome, uf)$v$;
  EXECUTE $v$CREATE INDEX IF NOT EXISTS ix_mv_div_pes_nome
  ON mv_divida_pessoa USING gin (nome gin_trgm_ops)$v$;
  EXECUTE $v$DROP MATERIALIZED VIEW IF EXISTS mv_uf$v$;
  EXECUTE $v$CREATE MATERIALIZED VIEW mv_uf AS
WITH pj AS (
  SELECT uf, count(*) AS empresas_com_divida, sum(valor_total) AS divida_total,
         max(data_referencia) AS data_referencia
    FROM mv_divida_empresa WHERE uf_valida(uf) GROUP BY uf
),
pf AS (
  SELECT uf, count(*) AS pessoas_com_divida, sum(valor_total) AS divida_pf
    FROM mv_divida_pessoa WHERE uf_valida(uf) GROUP BY uf
),
cadastro AS (
  SELECT uf, count(DISTINCT municipio_ibge) AS municipios,
         count(*) FILTER (WHERE situacao = 2) AS empresas_ativas
    FROM estabelecimento WHERE matriz AND uf_valida(uf) GROUP BY uf
)
SELECT
  coalesce(pj.uf, pf.uf)                 AS uf,
  coalesce(c.municipios, 0)              AS municipios,
  coalesce(c.empresas_ativas, 0)         AS empresas_ativas,
  coalesce(pj.empresas_com_divida, 0)    AS empresas_com_divida,
  coalesce(pj.divida_total, 0)           AS divida_total,
  coalesce(pf.pessoas_com_divida, 0)     AS pessoas_com_divida,
  coalesce(pf.divida_pf, 0)              AS divida_pf,
  coalesce(pj.data_referencia, (SELECT max(data_referencia) FROM mv_divida_pessoa))
                                         AS data_referencia
FROM pj FULL JOIN pf USING (uf)
LEFT JOIN cadastro c ON c.uf = coalesce(pj.uf, pf.uf)$v$;
  EXECUTE $v$CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_uf ON mv_uf (uf)$v$;
END $guarda$;
