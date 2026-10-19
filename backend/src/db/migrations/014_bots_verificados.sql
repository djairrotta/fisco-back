-- Vigia 1.1 (I): IPs confirmados como bots verificados (DNS reverso); não contam
-- como "acesso estrangeiro que passou" (cf.client.bot é isento da regra geo).
CREATE TABLE IF NOT EXISTS vigia.bots_verificados (
  ip inet PRIMARY KEY,
  visto_em timestamptz NOT NULL
);
