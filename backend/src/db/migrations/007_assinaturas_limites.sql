-- As assinaturas migradas do 1.0 (006) podem passar dos limites do 2.0
-- (nome/cargo 200 → 120, telefone 60 → 40, extra 300 → registro 120) e ter
-- um site que não é http(s). Normaliza: corta no limite novo e tira
-- site/redes que não são endereço http(s) (ou domínio sem esquema).
CREATE FUNCTION correio.tmp_url_ok(s text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT s IS NOT NULL
    AND char_length(btrim(s)) BETWEEN 1 AND 300
    AND btrim(s) !~ '[[:space:][:cntrl:]<>"]'
    AND (btrim(s) ~* '^https?://[^/]'
         OR (btrim(s) !~ '^[A-Za-z][A-Za-z0-9+.-]*:' AND btrim(s) !~ '^//'))
$$;

CREATE FUNCTION correio.tmp_corta(c jsonb, k text, n int) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(c -> k) = 'string'
    THEN jsonb_set(c, ARRAY[k], to_jsonb(left(btrim(c ->> k), n)))
    ELSE c END
$$;

CREATE FUNCTION correio.tmp_url(c jsonb, caminho text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN c #> caminho IS NULL THEN c
    WHEN jsonb_typeof(c #> caminho) = 'string'
         AND correio.tmp_url_ok(c #>> caminho)
      THEN jsonb_set(c, caminho, to_jsonb(btrim(c #>> caminho)))
    ELSE c #- caminho END
$$;

UPDATE correio.assinaturas SET campos =
  correio.tmp_url(correio.tmp_url(correio.tmp_url(correio.tmp_url(
  correio.tmp_url(correio.tmp_url(
  correio.tmp_corta(correio.tmp_corta(correio.tmp_corta(correio.tmp_corta(
  correio.tmp_corta(correio.tmp_corta(correio.tmp_corta(
    campos,
    'nome', 120), 'cargo', 120), 'empresa', 160), 'registro', 120),
    'telefone', 40), 'whatsapp', 40), 'endereco', 300),
    '{site}'), '{redes,linkedin}'), '{redes,instagram}'),
    '{redes,facebook}'), '{redes,x}'), '{redes,youtube}');

DROP FUNCTION correio.tmp_url(jsonb, text[]);
DROP FUNCTION correio.tmp_corta(jsonb, text, int);
DROP FUNCTION correio.tmp_url_ok(text);
