-- =====================================================================
-- REFRESH CONCURRENTLY exige indice UNICO sem WHERE. A mv_municipio_tributo
-- nasceu so com indice comum, entao toda atualizacao concorrente dela
-- falhava -- e atualizacao nao-concorrente trava a leitura do painel.
-- A chave natural e (uf, municipio_ibge, tributo).
-- =====================================================================
SET search_path TO fisco, public;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_mun_trib
  ON mv_municipio_tributo (uf, municipio_ibge, tributo);
