-- Vigia 2.0: OAuth 2.1 para os conectores do claude.ai e dos apps do Claude
-- (MCP authorization 2025-06-18). Clientes públicos com PKCE S256; códigos e
-- tokens guardados só como sha256.
CREATE TABLE IF NOT EXISTS vigia.oauth_clientes (
  client_id text PRIMARY KEY,
  nome text NOT NULL CHECK (length(nome) BETWEEN 1 AND 100),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  ip text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Uma concessão = um "app autorizado" (o que aparece em Config → Integrações).
CREATE TABLE IF NOT EXISTS vigia.oauth_concessoes (
  id bigserial PRIMARY KEY,
  client_id text NOT NULL REFERENCES vigia.oauth_clientes ON DELETE CASCADE,
  escopos text[] NOT NULL CHECK (escopos <@ ARRAY['ler', 'escrever']::text[]
    AND cardinality(escopos) >= 1),
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_uso timestamptz,
  revogado_em timestamptz,
  motivo_revogacao text
);

CREATE TABLE IF NOT EXISTS vigia.oauth_codigos (
  hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES vigia.oauth_clientes ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  desafio text NOT NULL,
  escopos text[] NOT NULL,
  expira timestamptz NOT NULL,
  usado_em timestamptz,
  concessao_id bigint REFERENCES vigia.oauth_concessoes ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vigia.oauth_tokens (
  hash text PRIMARY KEY,
  concessao_id bigint NOT NULL REFERENCES vigia.oauth_concessoes ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('acesso', 'refresh')),
  expira timestamptz NOT NULL,
  usado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_concessao
  ON vigia.oauth_tokens (concessao_id);
