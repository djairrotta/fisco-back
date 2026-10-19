CREATE SCHEMA IF NOT EXISTS correio;

-- Caixas de e-mail (poste.io). A senha fica cifrada no cofre (v1:iv:ct).
CREATE TABLE correio.caixas (
  id serial PRIMARY KEY,
  endereco text NOT NULL UNIQUE,
  nome_exibicao text NOT NULL DEFAULT '',
  senha_cifrada text NOT NULL,
  estado text NOT NULL DEFAULT 'ok'
    CHECK (estado IN ('ok', 'precisa_senha', 'erro')),
  cor text,
  logo bytea,
  logo_tipo text,
  favicon bytea,
  favicon_tipo text,
  assinatura jsonb NOT NULL DEFAULT '{}',
  ordem int NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Progresso do IMAP por caixa e pasta (UIDs são 32 bits sem sinal).
CREATE TABLE correio.estado_imap (
  caixa_id int NOT NULL REFERENCES correio.caixas(id) ON DELETE CASCADE,
  pasta text NOT NULL,
  uidvalidity bigint,
  ultimo_uid bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (caixa_id, pasta)
);

CREATE TABLE correio.passkeys (
  id serial PRIMARY KEY,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  criado timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE correio.sessoes (
  id serial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  expira timestamptz NOT NULL,
  dispositivo text
);

CREATE TABLE correio.push_inscricoes (
  id serial PRIMARY KEY,
  endpoint text NOT NULL UNIQUE,
  chaves jsonb NOT NULL,
  criado timestamptz NOT NULL DEFAULT now()
);

-- caixa_id NULL = padrão global; uma linha por caixa sobrescreve o padrão.
CREATE TABLE correio.config_notificacao (
  id serial PRIMARY KEY,
  caixa_id int REFERENCES correio.caixas(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('recebido', 'enviado', 'falha')),
  ativo boolean NOT NULL DEFAULT true
);
-- Índices parciais em vez de NULLS NOT DISTINCT (funciona em Postgres < 15).
CREATE UNIQUE INDEX config_notificacao_caixa_tipo_uq
  ON correio.config_notificacao (caixa_id, tipo) WHERE caixa_id IS NOT NULL;
CREATE UNIQUE INDEX config_notificacao_global_tipo_uq
  ON correio.config_notificacao (tipo) WHERE caixa_id IS NULL;

CREATE TABLE correio.config_ia (
  papel text PRIMARY KEY CHECK (papel IN ('classificador')),
  modelo text NOT NULL DEFAULT 'typesafe/jev-router',
  timeout_s int NOT NULL DEFAULT 20,
  ativo boolean NOT NULL DEFAULT true
);

CREATE TABLE correio.auditoria (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  ator text NOT NULL,
  acao text NOT NULL,
  alvo text,
  detalhes jsonb
);

CREATE FUNCTION correio.auditoria_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'correio.auditoria é imutável (% proibido)', TG_OP;
END;
$$;
CREATE TRIGGER auditoria_sem_truncate
  BEFORE TRUNCATE ON correio.auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION correio.auditoria_imutavel();
CREATE TRIGGER auditoria_sem_update_delete
  BEFORE UPDATE OR DELETE ON correio.auditoria
  FOR EACH ROW EXECUTE FUNCTION correio.auditoria_imutavel();

-- Seeds
INSERT INTO correio.config_ia (papel) VALUES ('classificador');

INSERT INTO correio.config_notificacao (caixa_id, tipo, ativo) VALUES
  (NULL, 'recebido', true),
  (NULL, 'enviado', true),
  (NULL, 'falha', true);
