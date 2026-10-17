-- =====================================================================
-- Particao DEFAULT nas duas tabelas particionadas por UF.
--
-- MOTIVO CONCRETO: o arquivo real da PGFN traz UF = 'SI' (1.531 linhas
-- so no FGTS do 2º tri/2026), que nao e unidade federativa. Sem uma
-- particao coringa o INSERT aborta com ExecFindPartition e derruba a
-- carga inteira -- 1,3 GB de download perdidos por causa de um codigo
-- fora da lista.
--
-- A linha desconhecida entra, fica isolada e visivel para auditoria, e
-- as views materializadas filtram por UF valida para que ela nunca
-- apareca como se fosse estado.
-- =====================================================================
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS divida_outras PARTITION OF divida_inscricao DEFAULT;
CREATE TABLE IF NOT EXISTS estabelecimento_outras PARTITION OF estabelecimento DEFAULT;

-- Lista oficial, usada pelas views para nao vazar codigo invalido.
CREATE OR REPLACE FUNCTION uf_valida(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p IN ('AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
               'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO')
$$;
