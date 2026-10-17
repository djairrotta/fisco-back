-- =====================================================================
-- Pessoa física entra na base.
--
-- Até aqui o ETL descartava 17,2 milhões de linhas de CPF por decisão de
-- produto. Agora elas entram, e isso obriga três correções, porque CPF
-- não cabe no formato pensado para CNPJ:
--
--  1. `cnpj char(14)` ENCHERIA O CPF DE ESPAÇOS à direita (char é de
--     largura fixa), e aí `documento = '12345678901'` nunca casaria com
--     a linha gravada. Vira varchar(14) e muda de nome para `documento`,
--     porque uma coluna chamada cnpj contendo CPF é mentira que cobra
--     juros depois.
--  2. `cnpj_raiz NOT NULL` não vale para CPF: não existe raiz. Passa a
--     aceitar NULL, e só PJ tem raiz. É por ela que se junta à base da
--     Receita, então PF simplesmente não participa desse join.
--  3. As views de EMPRESA passam a filtrar `tipo_pessoa = 'PJ'`. Sem
--     isso, 17 milhões de CPF virariam "empresas com dívida" no mapa, e
--     o número que o advogado usa para decidir onde prospectar seria
--     falso. Pessoa física ganha agregado próprio, separado.
-- =====================================================================
SET search_path TO fisco, public;

-- RENAME COLUMN nao e idempotente e o migrador roda tudo a cada boot:
-- na segunda execucao ele falharia com "column cnpj does not exist" e
-- derrubaria a migracao inteira. Mesmo erro que o CREATE TYPE cru.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='fisco' AND table_name='divida_inscricao'
                AND column_name='cnpj') THEN
    ALTER TABLE divida_inscricao ALTER COLUMN cnpj TYPE varchar(14);
    ALTER TABLE divida_inscricao RENAME COLUMN cnpj TO documento;
  END IF;
END $$;
ALTER TABLE divida_inscricao ALTER COLUMN cnpj_raiz DROP NOT NULL;
ALTER TABLE divida_inscricao ALTER COLUMN tipo_pessoa SET DEFAULT 'PJ';
UPDATE divida_inscricao SET tipo_pessoa = 'PJ' WHERE tipo_pessoa IS NULL;

-- Coerência: PJ tem 14 dígitos e raiz; PF tem 11 e não tem raiz.
ALTER TABLE divida_inscricao DROP CONSTRAINT IF EXISTS ck_documento;
ALTER TABLE divida_inscricao ADD CONSTRAINT ck_documento CHECK (
  (tipo_pessoa = 'PJ' AND length(documento) = 14 AND cnpj_raiz IS NOT NULL) OR
  (tipo_pessoa = 'PF' AND length(documento) = 11 AND cnpj_raiz IS NULL)
) NOT VALID;

CREATE INDEX IF NOT EXISTS ix_divida_documento
  ON divida_inscricao (documento) WHERE tipo_devedor = 1;

-- --- Agregados de EMPRESA: agora explicitamente só PJ ----------------
-- mv_municipio depende de mv_divida_empresa, entao o DROP ... CASCADE
-- acima a derruba junto. Recriar aqui, senao a migracao deixa as paginas
-- de cidade sem a view que elas consomem -- e o refresh so avisa que ela
-- sumiu, nao a traz de volta.
-- --- Agregado de PESSOA FÍSICA, separado --------------------------
-- Agrupa pelo documento, não pela raiz: CPF não tem raiz.
-- --- mv_uf: empresa e pessoa lado a lado, NUNCA somadas -------------

-- GUARDA (021): este bloco roda a cada boot. Sem a guarda ele apagava e
-- recalculava mv_divida_empresa, mv_municipio e mv_uf em TODO deploy, dentro
-- do limite de tempo do boot, sobre 30 milhoes de linhas. So recria quando
-- a view ainda tem a definicao antiga (sem o filtro de tipo_pessoa).
DO $guarda$
BEGIN
  IF to_regclass('fisco.mv_divida_empresa') IS NOT NULL
     AND pg_get_viewdef('fisco.mv_divida_empresa'::regclass) ILIKE '%tipo_pessoa%' THEN
    RETURN;
  END IF;
  EXECUTE $v$DROP MATERIALIZED VIEW IF EXISTS mv_uf$v$;
  EXECUTE $v$DROP MATERIALIZED VIEW IF EXISTS mv_divida_empresa CASCADE$v$;
  EXECUTE $v$CREATE MATERIALIZED VIEW mv_divida_empresa AS
SELECT
  d.cnpj_raiz, d.uf,
  count(*)                                 AS qtd_inscricoes,
  sum(d.valor_consolidado)                 AS valor_total,
  min(d.data_inscricao)                    AS inscricao_mais_antiga,
  max(d.data_referencia)                   AS data_referencia,
  mode() WITHIN GROUP (ORDER BY d.tributo)  AS tributo_principal,
  array_agg(DISTINCT d.tributo)            AS tributos,
  array_agg(DISTINCT d.origem::text)       AS origens,
  bool_or(d.ajuizado)                      AS tem_ajuizada
FROM divida_inscricao d
WHERE d.tipo_devedor = 1 AND d.tipo_pessoa = 'PJ'
GROUP BY d.cnpj_raiz, d.uf$v$;
  EXECUTE $v$CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_div_emp ON mv_divida_empresa (cnpj_raiz, uf)$v$;
  EXECUTE $v$CREATE MATERIALIZED VIEW IF NOT EXISTS mv_municipio AS
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
GROUP BY e.uf, e.municipio_ibge$v$;
  EXECUTE $v$CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_mun ON mv_municipio (uf, municipio_ibge)$v$;
  EXECUTE $v$CREATE MATERIALIZED VIEW IF NOT EXISTS mv_divida_pessoa AS
SELECT
  d.documento, d.uf,
  max(d.nome_devedor)                      AS nome,
  count(*)                                 AS qtd_inscricoes,
  sum(d.valor_consolidado)                 AS valor_total,
  min(d.data_inscricao)                    AS inscricao_mais_antiga,
  max(d.data_referencia)                   AS data_referencia,
  mode() WITHIN GROUP (ORDER BY d.tributo)  AS tributo_principal,
  bool_or(d.ajuizado)                      AS tem_ajuizada
FROM divida_inscricao d
WHERE d.tipo_devedor = 1 AND d.tipo_pessoa = 'PF'
GROUP BY d.documento, d.uf$v$;
  EXECUTE $v$CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_div_pes ON mv_divida_pessoa (documento, uf)$v$;
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
