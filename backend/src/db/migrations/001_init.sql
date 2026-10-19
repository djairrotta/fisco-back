CREATE SCHEMA IF NOT EXISTS vigia;

CREATE TABLE vigia.zonas (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  cf_zone_id text NOT NULL UNIQUE,
  ativa boolean NOT NULL DEFAULT true
);

CREATE TABLE vigia.cursores (
  zona_id int PRIMARY KEY REFERENCES vigia.zonas(id) ON DELETE CASCADE,
  ultimo_ts timestamptz NOT NULL
);

CREATE TABLE vigia.eventos (
  id bigserial PRIMARY KEY,
  zona_id int NOT NULL REFERENCES vigia.zonas(id) ON DELETE CASCADE,
  ts timestamptz NOT NULL,
  ip inet NOT NULL,
  pais text,
  asn bigint,
  host text,
  caminho text NOT NULL,
  metodo text,
  status int,
  ua text,
  acao_cf text,
  fonte text NOT NULL,
  UNIQUE (zona_id, ts, ip, caminho, fonte)
);
CREATE INDEX eventos_ts_idx ON vigia.eventos (ts);
CREATE INDEX eventos_ip_ts_idx ON vigia.eventos (ip, ts);

CREATE TABLE vigia.incidentes (
  id bigserial PRIMARY KEY,
  chave text NOT NULL,
  ips inet[] NOT NULL DEFAULT '{}',
  zonas int[] NOT NULL DEFAULT '{}',
  hosts text[] NOT NULL DEFAULT '{}',
  inicio timestamptz NOT NULL,
  fim timestamptz NOT NULL,
  sinais jsonb NOT NULL DEFAULT '[]',
  classe_final text,
  status text NOT NULL DEFAULT 'aberto'
);
CREATE INDEX incidentes_chave_idx ON vigia.incidentes (chave);
CREATE INDEX incidentes_status_idx ON vigia.incidentes (status, fim);

CREATE TABLE vigia.pareceres_ia (
  id bigserial PRIMARY KEY,
  incidente_id bigint NOT NULL REFERENCES vigia.incidentes(id) ON DELETE CASCADE,
  papel text NOT NULL,
  modelo text NOT NULL,
  classe text,
  confianca numeric,
  justificativa text,
  latencia_ms int,
  ok boolean NOT NULL DEFAULT false
);

CREATE TABLE vigia.bloqueios (
  id bigserial PRIMARY KEY,
  ip inet NOT NULL,
  incidente_id bigint REFERENCES vigia.incidentes(id) ON DELETE SET NULL,
  motivo text,
  criado timestamptz NOT NULL DEFAULT now(),
  expira timestamptz,
  removido timestamptz,
  cf_item_id text
);
CREATE INDEX bloqueios_ip_idx ON vigia.bloqueios (ip);

CREATE TABLE vigia.excecoes (
  id serial PRIMARY KEY,
  tipo text NOT NULL,
  valor text NOT NULL,
  nota text
);

CREATE TABLE vigia.permitidos (
  id serial PRIMARY KEY,
  ip inet NOT NULL UNIQUE,
  expira timestamptz,
  nota text
);

CREATE TABLE vigia.config_ia (
  papel text PRIMARY KEY,
  modelo text NOT NULL,
  timeout_ms int NOT NULL DEFAULT 20000,
  falhas_seguidas int NOT NULL DEFAULT 0,
  degradado_desde timestamptz,
  ultimo_aviso timestamptz
);

CREATE TABLE vigia.config_notificacao (
  tipo text PRIMARY KEY,
  push boolean NOT NULL DEFAULT true,
  whatsapp boolean NOT NULL DEFAULT true
);

CREATE TABLE vigia.config_geral (
  chave text PRIMARY KEY,
  valor jsonb NOT NULL
);

CREATE TABLE vigia.push_inscricoes (
  id serial PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,
  chaves jsonb NOT NULL,
  criado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vigia.passkeys (
  id serial PRIMARY KEY,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  criado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vigia.sessoes (
  id serial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  expira timestamptz NOT NULL,
  dispositivo text
);

CREATE TABLE vigia.auditoria (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  ator text NOT NULL,
  acao text NOT NULL,
  alvo text,
  detalhes jsonb
);

CREATE FUNCTION vigia.auditoria_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vigia.auditoria é imutável (% proibido)', TG_OP;
END;
$$;
CREATE TRIGGER auditoria_sem_truncate
  BEFORE TRUNCATE ON vigia.auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION vigia.auditoria_imutavel();
CREATE TRIGGER auditoria_sem_update_delete
  BEFORE UPDATE OR DELETE ON vigia.auditoria
  FOR EACH ROW EXECUTE FUNCTION vigia.auditoria_imutavel();

-- Seeds
INSERT INTO vigia.config_ia (papel, modelo, timeout_ms) VALUES
  ('jev', 'typesafe/jev-1.13', 20000),
  ('segunda', 'deepseek/deepseek-v4.1-flash', 20000),
  ('terceira', 'z-ai/glm-5.3-flash', 20000),
  ('investigacao', 'z-ai/glm-5.3-flash', 20000);

INSERT INTO vigia.config_notificacao (tipo, push, whatsapp) VALUES
  ('bloqueio_auto', true, true),
  ('sugestao', true, true),
  ('anomalia', true, true),
  ('estrangeiro_agregado', true, true),
  ('modelo_degradado', true, true),
  ('coletor_parado', true, true),
  ('bloqueio_expirado', true, true),
  ('desfeito', true, true),
  ('email_recebido', true, true),
  ('email_enviado', true, true);

INSERT INTO vigia.config_geral (chave, valor) VALUES
  ('modo_observacao_ate', to_jsonb(to_char((now() + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
