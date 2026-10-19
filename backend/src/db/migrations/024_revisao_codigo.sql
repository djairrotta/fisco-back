-- Análises de código do Revisor IA (upload de zip ou link do GitHub). Guarda
-- resumo + achados estruturados; mantemos as últimas execuções.
CREATE TABLE IF NOT EXISTS vigia.revisao_codigo (
  id bigserial PRIMARY KEY,
  criado timestamptz NOT NULL DEFAULT now(),
  repo text NOT NULL,
  origem text NOT NULL,            -- 'github:<owner>/<repo>' ou 'zip:<nome>'
  modelo text NOT NULL,
  resumo text NOT NULL,
  achados jsonb NOT NULL DEFAULT '[]'::jsonb,
  arquivos int NOT NULL DEFAULT 0
);

-- Push (sem WhatsApp) quando uma análise de código fecha com achado alto.
INSERT INTO vigia.config_notificacao (tipo, push, whatsapp)
VALUES ('revisao_codigo', true, false)
ON CONFLICT (tipo) DO NOTHING;
