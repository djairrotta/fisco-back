-- =====================================================================
-- fisco — esquema base
-- Um unico container Postgres atende todos os apps; este schema isola
-- o produto para nao colidir com os demais.
-- =====================================================================
-- REGRA: todo CREATE TYPE neste projeto vai dentro de
--   DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- CREATE TYPE nao aceita IF NOT EXISTS. Sem essa guarda a migracao
-- falha na SEGUNDA execucao (SQLSTATE 42710), o boot sai com codigo
-- nao-zero e o Swarm reverte o deploy sem erro visivel no codigo.
-- Ja aconteceu uma vez com maturidade_tese. Nao repita.

CREATE SCHEMA IF NOT EXISTS fisco;
SET search_path TO fisco, public;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- unaccent REMOVIDA: nome_chave() usa translate(), que e interna do
-- Postgres. Uma extensao a menos e um modo de falha a menos em banco
-- onde o papel da aplicacao nao pode criar extensao.

-- ---------------------------------------------------------------------
-- 1. Cadastro de empresas (base CNPJ da Receita Federal, carga mensal)
--    Particionado por UF: todo filtro do produto comeca por regiao.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estabelecimento (
  cnpj              char(14)     NOT NULL,
  cnpj_raiz         char(8)      NOT NULL,
  matriz            boolean      NOT NULL DEFAULT true,
  razao_social      text,
  nome_fantasia     text,
  situacao          smallint,              -- 2 = ativa
  data_situacao     date,
  cnae_principal    char(7),
  cnae_secundarios  char(7)[],
  porte             smallint,              -- 1 ME, 3 EPP, 5 demais
  capital_social    numeric(18,2),
  opcao_simples     boolean,
  opcao_mei         boolean,
  data_abertura     date,
  municipio_ibge    char(7),
  municipio         text,
  uf                char(2)      NOT NULL,
  cep               char(8),
  logradouro        text,
  numero            text,
  bairro            text,
  telefone          text,
  email             text,
  atualizado_em     date         NOT NULL,
  PRIMARY KEY (uf, cnpj)
) PARTITION BY LIST (uf);

-- ---------------------------------------------------------------------
-- 2. Divida ativa
--    PGFN publica TRIMESTRALMENTE em tres bases (Geral/Sida,
--    Previdenciaria, FGTS). Estados entram na mesma tabela por origem.
--    REGRA DA PGFN: somar apenas devedor principal; corresponsavel
--    duplica o valor. Por isso tipo_devedor entra na chave de filtro.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE origem_divida AS ENUM ('PGFN_GERAL','PGFN_PREV','PGFN_FGTS','PGE_SP','AGE_MG');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS divida_inscricao (
  id                bigserial,
  cnpj              char(14)     NOT NULL,
  cnpj_raiz         char(8)      NOT NULL,
  uf                char(2)      NOT NULL,
  origem            origem_divida NOT NULL,
  numero_inscricao  text,
  tipo_devedor      smallint     NOT NULL DEFAULT 1,  -- 1 principal, 2 corresponsavel
  tipo_situacao     text,
  situacao          text,
  receita_principal text,          -- identifica o tributo
  tributo           text,          -- normalizado a partir de receita_principal
  valor_consolidado numeric(18,2) NOT NULL,
  data_inscricao    date,
  unidade_origem    text,
  data_referencia   date         NOT NULL,  -- posicao da base; SEMPRE exibida
  PRIMARY KEY (uf, id)
) PARTITION BY LIST (uf);

-- ---------------------------------------------------------------------
-- 3. Teses: regra determinística versionada. NAO ha LLM aqui.
--    maturidade decide se a tese aparece no mapa; 'derrotada' zera o score.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE maturidade_tese AS ENUM
    ('consolidada_favoravel','em_disputa','modulada','derrotada');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tese (
  slug              text PRIMARY KEY,
  versao            int          NOT NULL DEFAULT 1,
  nome              text         NOT NULL,
  tributo           text         NOT NULL,
  fundamento_legal  text         NOT NULL,
  maturidade        maturidade_tese NOT NULL,
  -- identificadores que o Hermes reconsulta toda semana
  temas             jsonb        NOT NULL DEFAULT '[]',
  processos         jsonb        NOT NULL DEFAULT '[]',
  verificada_em     timestamptz,
  -- elegibilidade (avaliada em SQL, nunca por modelo)
  cnae_incluidos    char(7)[],
  cnae_excluidos    char(7)[],
  regimes           text[],
  portes            smallint[],
  ufs               char(2)[],
  exige_divida      boolean      NOT NULL DEFAULT false,
  tributos_divida   text[],
  prescricao_meses  int          NOT NULL DEFAULT 60,
  -- estimativa: SEMPRE proxy sobre faturamento presumido, nunca valor devido
  formula_estimativa jsonb,
  peso              numeric(4,2) NOT NULL DEFAULT 1.0,
  modelo_peca       text,
  checklist_docs    text[],
  ativa             boolean      NOT NULL DEFAULT true,
  criada_em         timestamptz  NOT NULL DEFAULT now(),
  atualizada_em     timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tese_historico_maturidade (
  id            bigserial PRIMARY KEY,
  tese_slug     text NOT NULL REFERENCES tese(slug),
  de            maturidade_tese,
  para          maturidade_tese NOT NULL,
  motivo        text,
  fonte         text,
  registrado_em timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 4. Processos (DJEN descobre pelo nome; DataJud enriquece pelo numero)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processo (
  numero_cnj    char(20) PRIMARY KEY,
  cnpj          char(14),
  cnpj_raiz     char(8),
  tribunal      text,
  classe        text,
  assunto       text,
  orgao_julgador text,
  valor_causa   numeric(18,2),
  distribuido_em date,
  ultimo_movimento jsonb,
  fonte         text NOT NULL,           -- 'djen' | 'datajud'
  confianca     smallint NOT NULL DEFAULT 50,  -- casamento por nome e incerto
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 5. Multi-tenant: assinantes
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE plano_tipo AS ENUM ('documentacao','com_ia');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            text NOT NULL,
  oab             text,
  email           text NOT NULL UNIQUE,
  plano           plano_tipo NOT NULL DEFAULT 'documentacao',
  pecas_mes       int NOT NULL DEFAULT 0,     -- 0 no plano documentacao
  pecas_usadas    int NOT NULL DEFAULT 0,
  ciclo_reinicia  date,
  timbrado_path   text,
  asaas_id        text,
  ativo           boolean NOT NULL DEFAULT true,
  criado_em       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj       char(14) NOT NULL,
  tese_slug  text REFERENCES tese(slug),
  estagio    text NOT NULL DEFAULT 'novo',
  anotacoes  text,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cnpj, tese_slug)
);

CREATE TABLE IF NOT EXISTS peca (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj        char(14) NOT NULL,
  tese_slug   text NOT NULL REFERENCES tese(slug),
  campos      jsonb NOT NULL,          -- o que a LLM devolveu
  modelo_ia   text NOT NULL,
  tokens_in   int, tokens_out int, custo_usd numeric(12,8),
  exige_revisao boolean NOT NULL DEFAULT false,
  motivo_revisao text,
  arquivo_path text,
  criada_em   timestamptz NOT NULL DEFAULT now()
);

-- ordem de servico enviada ao NEXUS para calculo tributario
CREATE TABLE IF NOT EXISTS ordem_calculo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj         char(14) NOT NULL,
  tese_slug    text NOT NULL REFERENCES tese(slug),
  nexus_id     text,
  status       text NOT NULL DEFAULT 'aberta',
  laudo_url    text,
  criada_em    timestamptz NOT NULL DEFAULT now(),
  concluida_em timestamptz
);
