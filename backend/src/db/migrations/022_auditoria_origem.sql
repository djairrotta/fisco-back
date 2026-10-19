-- Origem do host na auditoria: 'trafego' (visto no tráfego, entra como
-- sugestão), 'easypanel' (descoberto nos apps do EasyPanel — é do Djair,
-- entra já confirmado para o Vigia varrer sozinho) ou 'manual' (adicionado
-- à mão). Não reabre host 'removido'.
ALTER TABLE vigia.auditoria_hosts
  ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'trafego'
  CHECK (origem IN ('trafego', 'easypanel', 'manual'));
