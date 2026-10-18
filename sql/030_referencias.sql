-- Tabelas de referencia da Receita e do IBGE: descricao de CNAE (com secao
-- e divisao), natureza juridica, qualificacao de socio, motivo de situacao.
-- Preenchidas no boot quando vazias (services/referencias.ts).
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS cnae_ref (
  codigo     char(7) PRIMARY KEY,
  descricao  text NOT NULL,
  divisao    char(2) NOT NULL,
  secao      char(1) NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cnae_ref_secao ON cnae_ref (secao);
CREATE INDEX IF NOT EXISTS ix_cnae_ref_desc ON cnae_ref USING gin (descricao gin_trgm_ops);

CREATE TABLE IF NOT EXISTS natureza_ref (
  codigo     char(4) PRIMARY KEY,
  descricao  text NOT NULL,
  grupo      text            -- empresario | sociedade | publica | sem_fins | outras
);
CREATE TABLE IF NOT EXISTS qualificacao_ref (
  codigo     smallint PRIMARY KEY,
  descricao  text NOT NULL
);
CREATE TABLE IF NOT EXISTS motivo_situacao_ref (
  codigo     smallint PRIMARY KEY,
  descricao  text NOT NULL
);
