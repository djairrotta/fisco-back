-- Vigia 2.0 (1.1): tokens de acesso à API v1 e ao MCP. Só o hash (sha256) é
-- guardado; o token aparece uma única vez, na criação pelo PWA.
CREATE TABLE IF NOT EXISTS vigia.tokens_api (
  id bigserial PRIMARY KEY,
  nome text NOT NULL CHECK (length(nome) BETWEEN 1 AND 60),
  hash text NOT NULL UNIQUE,
  escopos text[] NOT NULL CHECK (escopos <@ ARRAY['ler', 'escrever']::text[]
    AND cardinality(escopos) >= 1),
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz,
  revogado_em timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_api_nome_ativo
  ON vigia.tokens_api (nome) WHERE revogado_em IS NULL;

-- Vigia 2.0 (1.4): estado da regra "Vigia: proteções" e do rate limiting por zona.
CREATE TABLE IF NOT EXISTS vigia.protecoes_zona (
  cf_zone_id text PRIMARY KEY,
  regra text NOT NULL,
  rate text NOT NULL,
  detalhe text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vigia.config_geral (chave, valor) VALUES
  ('protecoes_modo', to_jsonb('bloquear'::text)),
  ('protecoes_rate_ativo', 'true'::jsonb)
ON CONFLICT (chave) DO NOTHING;
