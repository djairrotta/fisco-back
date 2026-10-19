-- Vigia 1.1: cache da localização aproximada de IPs (provedor externo), 7 dias.
CREATE TABLE IF NOT EXISTS vigia.ip_local (
  ip inet PRIMARY KEY,
  dados jsonb NOT NULL,
  fonte text NOT NULL,
  consultado_em timestamptz NOT NULL
);
