-- =====================================================================
-- Ajuste do schema ao CSV REAL da PGFN.
--
-- O ETL anterior foi escrito contra um esquema imaginado e nao bate com
-- o arquivo publicado. Colunas reais (15, separador ';', LATIN1):
--   CPF_CNPJ TIPO_PESSOA TIPO_DEVEDOR NOME_DEVEDOR UF_DEVEDOR
--   UNIDADE_RESPONSAVEL ENTIDADE_RESPONSAVEL UNIDADE_INSCRICAO
--   NUMERO_INSCRICAO TIPO_SITUACAO_INSCRICAO SITUACAO_INSCRICAO
--   RECEITA_PRINCIPAL DATA_INSCRICAO INDICADOR_AJUIZADO VALOR_CONSOLIDADO
--
-- Tres consequencias:
--  1. NOME_DEVEDOR existe. Nao dependemos da base da Receita para exibir
--     o nome da empresa, so para municipio, CNAE, porte e regime.
--  2. TIPO_PESSOA separa PJ de PF. Pessoa fisica fica fora do produto.
--  3. INDICADOR_AJUIZADO diz se ja virou execucao fiscal, que muda
--     completamente a conversa com o cliente.
-- =====================================================================
SET search_path TO fisco, public;

ALTER TABLE divida_inscricao
  ADD COLUMN IF NOT EXISTS nome_devedor  text,
  ADD COLUMN IF NOT EXISTS tipo_pessoa   char(2),   -- PJ | PF
  ADD COLUMN IF NOT EXISTS ajuizado      boolean,
  ADD COLUMN IF NOT EXISTS unidade_inscricao text;

-- Quem ja esta ajuizado e outro produto: a conversa deixa de ser
-- prospeccao de tese e vira defesa em execucao. Indice parcial porque
-- o filtro mais usado continua sendo o devedor principal.
CREATE INDEX IF NOT EXISTS ix_divida_ajuizado
  ON divida_inscricao (uf, ajuizado)
  WHERE tipo_devedor = 1;

CREATE INDEX IF NOT EXISTS ix_divida_nome
  ON divida_inscricao USING gin (nome_devedor gin_trgm_ops)
  WHERE tipo_devedor = 1;

-- Registro de cargas: sem isto nao da para saber se o numero na tela
-- esta velho, nem qual trimestre esta no banco.
CREATE TABLE IF NOT EXISTS carga_etl (
  id             bigserial PRIMARY KEY,
  origem         text        NOT NULL,
  periodo        text        NOT NULL,      -- AAAAMM da base
  arquivos       int         NOT NULL DEFAULT 0,
  linhas_lidas   bigint      NOT NULL DEFAULT 0,
  linhas_aceitas bigint      NOT NULL DEFAULT 0,
  linhas_rejeitadas bigint   NOT NULL DEFAULT 0,
  comecou_em     timestamptz NOT NULL DEFAULT now(),
  terminou_em    timestamptz,
  erro           text,
  UNIQUE (origem, periodo)
);
