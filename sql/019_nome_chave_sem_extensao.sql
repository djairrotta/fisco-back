-- =====================================================================
-- nome_chave() deixa de depender da extensão unaccent.
--
-- DEFEITO QUE ISTO CORRIGE, visto em produção:
--   "function unaccent(text) does not exist"
--
-- Duas causas somadas:
--  1. `unaccent` é EXTENSÃO, e foi criada no schema `fisco`. Uma função
--     SQL sem `SET search_path` resolve os nomes com o search_path de
--     QUEM CHAMA, não o de quem criou. Chamada de uma sessão sem `fisco`
--     no caminho, ela não acha o unaccent.
--  2. Extensão pode simplesmente não existir no banco de destino, e aí
--     qualificar o schema não salva nada.
--
-- translate() é função interna do Postgres: não precisa de extensão, não
-- depende de search_path e é IMMUTABLE de verdade, que é requisito para
-- entrar em índice. A tabela cobre o português, que é o universo dos
-- nomes desta base.
-- =====================================================================
SET search_path TO fisco, public;

CREATE OR REPLACE FUNCTION nome_chave(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(
    trim(regexp_replace(
      translate(upper(coalesce(p, '')),
                'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
                'AAAAAAEEEEIIIIOOOOOUUUUCNY'),
      '[^A-Z0-9]+', ' ', 'g')), '')
$$;
