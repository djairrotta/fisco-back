-- Vigia 1.1: diagnóstico por chamada de IA e timeout do Jev em 45 s.
ALTER TABLE vigia.config_ia
  ADD COLUMN IF NOT EXISTS ultimo_ok_em timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_erro_em timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_erro text;
-- Só altera se ainda for o padrão antigo (preserva valor escolhido pelo Djair).
UPDATE vigia.config_ia SET timeout_ms = 45000
WHERE papel = 'jev' AND timeout_ms = 20000;
