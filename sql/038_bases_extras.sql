-- Bases publicas extras por CNPJ (Receita, CGU, MCTI, MTE, ANP, ANTT):
-- regime tributario (ECF), beneficios fiscais (SISEN: Empresa Cidada,
-- PERSE, REIDI...), incentivos deduzidos (PAT, Lei Rouanet...), parcelamentos
-- com saldo, sancoes (CEIS/CNEP), Lei do Bem, lista suja do trabalho,
-- postos de combustivel, transportadores (RNTRC). Uma linha por marca.
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS empresa_marca (
  cnpj_raiz  char(8) NOT NULL,
  cnpj       char(14),
  fonte      text NOT NULL,
  tipo       text NOT NULL,
  ano        smallint,
  valor      numeric(18,2),
  detalhe    jsonb
);
CREATE INDEX IF NOT EXISTS ix_marca_raiz ON empresa_marca (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_marca_fonte ON empresa_marca (fonte, tipo, cnpj_raiz);

CREATE TABLE IF NOT EXISTS fonte_extra (
  fonte        text PRIMARY KEY,
  ultima_carga timestamptz,
  linhas       integer,
  erro         text,
  tentativa_em timestamptz
);
