-- No máximo um bloqueio não removido por IP.
-- Antes, encerra duplicatas antigas (mantém a mais recente).
UPDATE vigia.bloqueios b SET removido = now()
WHERE b.removido IS NULL
  AND EXISTS (
    SELECT 1 FROM vigia.bloqueios o
    WHERE o.ip = b.ip AND o.removido IS NULL AND o.id > b.id
  );
CREATE UNIQUE INDEX bloqueios_ip_ativo_uq ON vigia.bloqueios (ip) WHERE removido IS NULL;
