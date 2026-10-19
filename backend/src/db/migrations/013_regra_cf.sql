-- Vigia 1.1 (I): regra do Cloudflare que agiu no evento de firewall (description).
ALTER TABLE vigia.eventos ADD COLUMN IF NOT EXISTS regra_cf text;
