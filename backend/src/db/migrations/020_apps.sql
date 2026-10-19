-- Apps do EasyPanel: snapshot atualizado a cada 2 min pelo monitor. Nada do
-- env é gravado aqui (a análise de higiene vai para auditoria_achados, só com
-- nomes de variáveis).
CREATE TABLE IF NOT EXISTS vigia.apps (
  projeto text NOT NULL,
  servico text NOT NULL,
  tipo text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('running', 'stopped', 'error', 'unknown')),
  replicas int,
  cpu double precision,
  mem_bytes bigint,
  mem_pct double precision,
  dominios text[] NOT NULL DEFAULT '{}',
  ultima_mudanca timestamptz,
  -- Viradas para "running" (vindo de parado/erro).
  reinicios int NOT NULL DEFAULT 0,
  reinicios_recentes timestamptz[] NOT NULL DEFAULT '{}',
  visto_em timestamptz NOT NULL,
  PRIMARY KEY (projeto, servico)
);

INSERT INTO vigia.config_notificacao (tipo, push, whatsapp) VALUES
  ('app_status', true, false),
  ('app_reinicios', true, false),
  ('easypanel_falha', true, false)
ON CONFLICT (tipo) DO NOTHING;
