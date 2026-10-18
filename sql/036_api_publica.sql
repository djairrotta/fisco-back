-- API publica: chaves por escritorio (so o hash fica no banco) e uso.
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS api_chave (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  prefixo     text NOT NULL,
  hash        text NOT NULL UNIQUE,
  criado_por  uuid,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  ultimo_uso  timestamptz,
  usos        bigint NOT NULL DEFAULT 0,
  revogada_em timestamptz
);
CREATE INDEX IF NOT EXISTS ix_api_chave_tenant ON api_chave (tenant_id);
