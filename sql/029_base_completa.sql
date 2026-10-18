-- =====================================================================
-- 029: BASE COMPLETA da Receita (todas as empresas, nao so as devedoras)
-- para a pesquisa no nivel do EmpresAqui: 66 milhoes de estabelecimentos.
--
-- A pesquisa roda direto na tabela particionada por UF. Para nao precisar
-- de JOIN com milhoes de linhas a cada filtro, o que vem de Empresas e
-- Simples (natureza, porte, capital, regime, MEI e datas) fica COPIADO no
-- estabelecimento na carga. Divida e sinais continuam vindo das views por
-- raiz (poucos milhoes de linhas, com indice unico).
--
-- Tudo aqui e guardado por verificacao em pg_attribute/to_regclass:
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS pega lock exclusivo MESMO
-- quando a coluna ja existe, e essa migracao roda a cada boot.
-- =====================================================================
SET search_path TO fisco, public;

DO $c$
DECLARE
  col record;
BEGIN
  FOR col IN SELECT * FROM (VALUES
      ('estabelecimento', 'natureza_juridica', 'char(4)'),
      ('estabelecimento', 'data_opcao_simples', 'date'),
      ('estabelecimento', 'data_exclusao_simples', 'date'),
      ('estabelecimento', 'data_opcao_mei', 'date'),
      ('estabelecimento', 'data_exclusao_mei', 'date'),
      ('estabelecimento', 'telefone2', 'text'),
      ('estabelecimento', 'motivo_situacao', 'smallint'),
      ('estabelecimento', 'situacao_especial', 'text'),
      ('estabelecimento', 'complemento', 'text'),
      ('estabelecimento', 'email_contador', 'boolean'),
      ('estabelecimento', 'telefone_contador', 'boolean'),
      ('estabelecimento', 'hash_rfb', 'text'),
      ('empresa_rfb', 'data_opcao_mei', 'date'),
      ('empresa_rfb', 'data_exclusao_mei', 'date'),
      ('empresa_rfb', 'qualificacao_responsavel', 'smallint'),
      ('empresa_rfb', 'ente_federativo', 'text'),
      ('empresa_rfb', 'hash_rfb', 'text'),
      ('socio', 'hash_rfb', 'text')
    ) AS t(tabela, coluna, tipo)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = ('fisco.' || col.tabela)::regclass
                      AND attname = col.coluna AND NOT attisdropped) THEN
      EXECUTE format('ALTER TABLE fisco.%I ADD COLUMN %I %s', col.tabela, col.coluna, col.tipo);
    END IF;
  END LOOP;
END $c$;

-- Qualidade do contato, para a ordenacao "melhores contatos": celular vale
-- mais que fixo, e contato que e do contador (repetido em muitas empresas)
-- nao conta.
DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fisco.estabelecimento'::regclass
                  AND attname = 'pontos_contato' AND NOT attisdropped) THEN
    ALTER TABLE fisco.estabelecimento ADD COLUMN pontos_contato smallint GENERATED ALWAYS AS (
      (CASE WHEN email IS NOT NULL AND coalesce(email_contador, false) = false THEN 3 ELSE 0 END) +
      (CASE WHEN telefone ~ '^\d{2}9\d{8}$' AND coalesce(telefone_contador, false) = false THEN 3
            WHEN telefone IS NOT NULL AND coalesce(telefone_contador, false) = false THEN 2 ELSE 0 END) +
      (CASE WHEN telefone2 IS NOT NULL THEN 1 ELSE 0 END)
    ) STORED;
  END IF;
END $p$;

-- Indices da pesquisa. Definidos no pai, propagam para cada UF.
DO $i$
BEGIN
  IF to_regclass('fisco.ix_estab_busca_sit') IS NULL THEN
    CREATE INDEX ix_estab_busca_sit ON fisco.estabelecimento (uf, situacao, municipio_ibge);
  END IF;
  IF to_regclass('fisco.ix_estab_cnae_sit') IS NULL THEN
    CREATE INDEX ix_estab_cnae_sit ON fisco.estabelecimento (cnae_principal, uf, situacao);
  END IF;
  IF to_regclass('fisco.ix_estab_cnae_sec') IS NULL THEN
    CREATE INDEX ix_estab_cnae_sec ON fisco.estabelecimento USING gin (cnae_secundarios);
  END IF;
  IF to_regclass('fisco.ix_estab_abertura') IS NULL THEN
    CREATE INDEX ix_estab_abertura ON fisco.estabelecimento (uf, data_abertura DESC);
  END IF;
  IF to_regclass('fisco.ix_estab_cep') IS NULL THEN
    CREATE INDEX ix_estab_cep ON fisco.estabelecimento (cep);
  END IF;
  IF to_regclass('fisco.ix_estab_contato') IS NULL THEN
    CREATE INDEX ix_estab_contato ON fisco.estabelecimento (uf, pontos_contato DESC, data_abertura DESC);
  END IF;
  -- Razao social ja tem trigrama (003); o nome fantasia ganha o seu.
  IF to_regclass('fisco.ix_estab_fantasia_trgm') IS NULL THEN
    CREATE INDEX ix_estab_fantasia_trgm ON fisco.estabelecimento USING gin (nome_fantasia gin_trgm_ops);
  END IF;
  IF to_regclass('fisco.ix_estab_email') IS NULL THEN
    CREATE INDEX ix_estab_email ON fisco.estabelecimento (email) WHERE email IS NOT NULL;
  END IF;
  IF to_regclass('fisco.ix_estab_telefone') IS NULL THEN
    CREATE INDEX ix_estab_telefone ON fisco.estabelecimento (telefone) WHERE telefone IS NOT NULL;
  END IF;
END $i$;

-- Municipios: populacao (IBGE) e coordenadas da sede, para "quantidade de
-- habitantes" e "raio em km" (o raio e medido entre sedes de municipio:
-- a Receita nao publica coordenada de empresa).
CREATE TABLE IF NOT EXISTS municipio_ref (
  municipio_ibge  char(7) PRIMARY KEY,
  nome            text    NOT NULL,
  uf              char(2) NOT NULL,
  populacao       integer,
  lat             double precision,
  lon             double precision,
  capital         boolean NOT NULL DEFAULT false,
  atualizado_em   date    NOT NULL DEFAULT current_date
);
CREATE INDEX IF NOT EXISTS ix_municipio_ref_uf ON municipio_ref (uf);

-- Por raiz: quantos estabelecimentos (para "com 10+ filiais") e socios.
-- Recalculada depois de cada carga da Receita.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_raiz AS
SELECT e.cnpj_raiz,
       count(*)::int                                   AS qtd_estab,
       count(*) FILTER (WHERE e.situacao = 2)::int     AS qtd_ativos,
       (SELECT count(*)::int FROM socio s WHERE s.cnpj_raiz = e.cnpj_raiz) AS qtd_socios
  FROM estabelecimento e
 GROUP BY e.cnpj_raiz
WITH NO DATA;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_raiz ON mv_raiz (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_mv_raiz_estab ON mv_raiz (qtd_estab DESC);

-- Controle da carga completa da Receita (etapas e contagens).
CREATE TABLE IF NOT EXISTS rfb_carga (
  periodo       text        NOT NULL,
  etapa         text        NOT NULL,     -- empresas | estabelecimentos | socios | contador | raiz
  status        text        NOT NULL DEFAULT 'pendente',
  lidas         bigint,
  inseridas     bigint,
  atualizadas   bigint,
  removidas     bigint,
  comecou_em    timestamptz,
  terminou_em   timestamptz,
  erro          text,
  PRIMARY KEY (periodo, etapa)
);
