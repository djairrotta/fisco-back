-- Conector MCP/admin: allowlist de faixas (vendedores + decisões do usuário) e
-- pedidos de liberação. A faixa da Anthropic (160.79.104.0/21) fica embutida no
-- código; esta tabela guarda as faixas de vendedores buscadas (ex.: OpenAI/Codex)
-- e as decisões do usuário (temporário/permanente). "bloquear" não entra aqui.
CREATE TABLE IF NOT EXISTS vigia.conector_faixas (
  faixa  text PRIMARY KEY,
  modo   text NOT NULL CHECK (modo IN ('vendor', 'permanente', 'temporario')),
  origem text NOT NULL DEFAULT 'manual',
  expira timestamptz,
  criado timestamptz NOT NULL DEFAULT now()
);

-- Um pedido por faixa: pendente (aguardando decisão) ou já decidido. O índice
-- único evita reperguntar a mesma faixa a cada ciclo.
CREATE TABLE IF NOT EXISTS vigia.conector_pedido (
  id       serial PRIMARY KEY,
  faixa    text NOT NULL,
  ip       text,
  origem   text NOT NULL DEFAULT '',
  caminho  text NOT NULL DEFAULT '',
  estado   text NOT NULL DEFAULT 'pendente'
           CHECK (estado IN ('pendente', 'temporario', 'permanente', 'bloqueado')),
  criado   timestamptz NOT NULL DEFAULT now(),
  decidido timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS conector_pedido_faixa
  ON vigia.conector_pedido (faixa);

-- push-only: o push leva os botões temporário/permanente/bloquear; o WhatsApp
-- só mandaria texto sem os botões de decisão.
INSERT INTO vigia.config_notificacao (tipo, push, whatsapp)
VALUES ('conector_pedido', true, false)
ON CONFLICT (tipo) DO NOTHING;
