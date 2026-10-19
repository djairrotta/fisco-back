-- Auditoria diária de configuração dos sites do Djair (só hosts das zonas do
-- Vigia). Hosts: sugeridos a partir do tráfego coletado até ele confirmar;
-- "removido" fica registrado para a sugestão não voltar.
CREATE TABLE IF NOT EXISTS vigia.auditoria_hosts (
  host text PRIMARY KEY CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  zona_id int REFERENCES vigia.zonas(id) ON DELETE CASCADE,
  estado text NOT NULL CHECK (estado IN ('sugerido', 'confirmado', 'removido')),
  acessos bigint,
  criado timestamptz NOT NULL DEFAULT now(),
  atualizado timestamptz NOT NULL DEFAULT now()
);

-- Um achado por host + verificação; resolvido_em preenchido quando some.
CREATE TABLE IF NOT EXISTS vigia.auditoria_achados (
  id bigserial PRIMARY KEY,
  host text NOT NULL,
  verificacao text NOT NULL,
  severidade text NOT NULL CHECK (severidade IN ('baixa', 'media', 'alta')),
  titulo text NOT NULL,
  recomendacao_ptbr text NOT NULL,
  evidencia text,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  resolvido_em timestamptz,
  UNIQUE (host, verificacao)
);
CREATE INDEX IF NOT EXISTS auditoria_achados_abertos_idx
  ON vigia.auditoria_achados (host) WHERE resolvido_em IS NULL;

-- Push só (sem WhatsApp) para achados novos de severidade média/alta.
INSERT INTO vigia.config_notificacao (tipo, push, whatsapp)
VALUES ('auditoria_achado', true, false)
ON CONFLICT (tipo) DO NOTHING;
