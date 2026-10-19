-- Vigia 2.1: alertas do próprio servidor (temperatura, memória, carga, disco).
INSERT INTO vigia.config_notificacao (tipo, push, whatsapp) VALUES
  ('servidor', true, false)
ON CONFLICT (tipo) DO NOTHING;
