-- Revisor IA: papel de IA dedicado que roda a análise de segurança (caixa-preta)
-- sobre os achados da varredura/auditoria, de forma autônoma, com as LLMs do
-- OpenRouter já cadastradas. Modelo trocável pelo painel (definir_config_ia).
-- Timeout maior porque é uma análise longa, não uma triagem de 1 incidente.
INSERT INTO vigia.config_ia (papel, modelo, timeout_ms) VALUES
  ('revisor', 'anthropic/claude-opus-4.8', 60000)
ON CONFLICT (papel) DO NOTHING;

-- Guarda a última análise do Revisor (texto + achados estruturados em jsonb).
-- Mantemos poucas execuções; o painel e o MCP leem a mais recente.
CREATE TABLE IF NOT EXISTS vigia.revisao (
  id bigserial PRIMARY KEY,
  criado timestamptz NOT NULL DEFAULT now(),
  modelo text NOT NULL,
  resumo text NOT NULL,
  achados jsonb NOT NULL DEFAULT '[]'::jsonb,
  hosts int NOT NULL DEFAULT 0
);

-- Push (sem WhatsApp) quando o Revisor fecha uma análise com achado alto.
INSERT INTO vigia.config_notificacao (tipo, push, whatsapp)
VALUES ('revisao_ia', true, false)
ON CONFLICT (tipo) DO NOTHING;
