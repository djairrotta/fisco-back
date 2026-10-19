-- Última decisão do ciclo (ação, motivo, observação, bloqueios) para o PWA.
ALTER TABLE vigia.incidentes ADD COLUMN IF NOT EXISTS decisao jsonb;
