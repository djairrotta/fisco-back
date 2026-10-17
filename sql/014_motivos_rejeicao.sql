-- =====================================================================
-- Motivo da rejeicao, nao so a contagem.
--
-- No 2o tri/2026 o Nao Previdenciario rejeitou 17.241.918 de 45.553.971
-- linhas, 38% do arquivo. Com um contador unico, "38% sao pessoa fisica"
-- e "38% quebraram no parse" sao indistinguiveis -- e a diferenca entre
-- comportamento correto e perder um terco do mercado.
-- =====================================================================
SET search_path TO fisco, public;
ALTER TABLE carga_etl ADD COLUMN IF NOT EXISTS motivos_rejeicao jsonb;
