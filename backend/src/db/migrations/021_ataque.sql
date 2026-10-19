-- Plano de controle de testes ofensivos (apenas o cadastro e o gate; a
-- exploração real exige um runner isolado que o Djair opta por usar). Toda
-- campanha só pode mirar um host das zonas do Vigia marcado como teste.

-- Ambiente do host auditado: produção (padrão) ou teste/staging. Campanhas de
-- teste ofensivo só são permitidas contra hosts marcados como 'teste'.
ALTER TABLE vigia.auditoria_hosts
  ADD COLUMN IF NOT EXISTS ambiente text NOT NULL DEFAULT 'producao'
  CHECK (ambiente IN ('producao', 'teste'));

CREATE TABLE IF NOT EXISTS vigia.ataque_campanha (
  id bigserial PRIMARY KEY,
  -- Alvo como o usuário informou (hostname ou URL); host é o hostname extraído.
  alvo text NOT NULL,
  host text NOT NULL CHECK (host ~ '^[a-z0-9.-]{1,253}$'),
  tipo text NOT NULL
    CHECK (tipo IN ('forca_bruta_simulada', 'fuzz_leve', 'enumeracao')),
  estado text NOT NULL DEFAULT 'rascunho'
    CHECK (estado IN ('rascunho', 'autorizada', 'concluida', 'cancelada')),
  -- Parâmetros da campanha (ex.: caminho de login, caminhos a fuzzar).
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-256 do token de confirmação exigido para autorizar.
  confirm_hash text NOT NULL,
  autorizado_por text,
  autorizado_em timestamptz,
  resultado jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ataque_campanha_estado_idx
  ON vigia.ataque_campanha (estado, id DESC);
