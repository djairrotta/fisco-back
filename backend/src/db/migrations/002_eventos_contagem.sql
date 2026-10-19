-- Contagem por evento (http agrupado), chave de dedupe e cursor http separado.
ALTER TABLE vigia.eventos ADD COLUMN contagem int NOT NULL DEFAULT 1;
ALTER TABLE vigia.eventos ADD COLUMN chave_dedupe text;
UPDATE vigia.eventos SET chave_dedupe = 'legado-' || id WHERE chave_dedupe IS NULL;
ALTER TABLE vigia.eventos ALTER COLUMN chave_dedupe SET NOT NULL;
ALTER TABLE vigia.eventos DROP CONSTRAINT IF EXISTS eventos_zona_id_ts_ip_caminho_fonte_key;
ALTER TABLE vigia.eventos ADD CONSTRAINT eventos_zona_chave_key UNIQUE (zona_id, chave_dedupe);
ALTER TABLE vigia.cursores ADD COLUMN ultimo_ts_http timestamptz;
