-- Vigia 1.1: incidentes adiados pela triagem (limite por ciclo) voltam no próximo ciclo.
ALTER TABLE vigia.incidentes
  ADD COLUMN IF NOT EXISTS triagem_pendente boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS incidentes_pendentes_idx
  ON vigia.incidentes (inicio) WHERE triagem_pendente;
