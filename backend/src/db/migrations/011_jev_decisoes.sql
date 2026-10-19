-- Vigia 1.1: o Jev passa a ser typesafe/jev-1.13 pela Decisions API do
-- OpenRouter (decisão tipada, P50 ~0,16 s). Só troca o que ainda está no
-- padrão; modelo/timeout escolhidos pelo Djair ficam intactos.
UPDATE vigia.config_ia SET modelo = 'typesafe/jev-1.13'
WHERE papel = 'jev' AND modelo = 'typesafe/jev-router';
UPDATE vigia.config_ia SET timeout_ms = 10000
WHERE papel = 'jev' AND modelo = 'typesafe/jev-1.13'
  AND timeout_ms IN (20000, 45000);
