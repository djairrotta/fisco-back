-- Auditoria anônima de instâncias Supabase self-hosted. A anon key é PÚBLICA
-- por design (vai no front), então fica em texto aqui; a service key nunca é
-- guardada nem usada.
CREATE TABLE IF NOT EXISTS vigia.supabase_instancias (
  id bigserial PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  url text NOT NULL,
  anon_key text NOT NULL,
  criado timestamptz NOT NULL DEFAULT now()
);

-- Resultado mais recente por instância (o todo em jsonb; achados inclusos).
CREATE TABLE IF NOT EXISTS vigia.supabase_resultado (
  instancia text PRIMARY KEY,
  url text NOT NULL,
  criado timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  resultado jsonb NOT NULL
);

-- Push (sem WhatsApp) para achado novo alto/crítico do Supabase.
INSERT INTO vigia.config_notificacao (tipo, push, whatsapp)
VALUES ('supabase_achado', true, false)
ON CONFLICT (tipo) DO NOTHING;
