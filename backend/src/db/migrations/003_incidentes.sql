ALTER TABLE vigia.incidentes
  ADD COLUMN IF NOT EXISTS severidade_max text NOT NULL DEFAULT 'baixa';
CREATE INDEX IF NOT EXISTS incidentes_chave_status_idx ON vigia.incidentes (chave, status);
ALTER TABLE vigia.incidentes
  ADD COLUMN IF NOT EXISTS total_sinais int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS contagem_total bigint NOT NULL DEFAULT 0;
