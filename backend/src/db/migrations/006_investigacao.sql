ALTER TABLE vigia.incidentes
  ADD COLUMN IF NOT EXISTS investigacao jsonb,
  ADD COLUMN IF NOT EXISTS investigado_em timestamptz;
