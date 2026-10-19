-- Vigia (out/2026), regras do Djair:
-- 1. Jev numa classe maliciosa com confiança >= jev_limiar (padrão 0,5) bloqueia
--    por 7 dias sem exigir 2ª opinião; jev_exige_segunda = true volta à regra
--    antiga (Jev e 2ª opinião da mesma classe >= limiar).
-- 2. IPs de datacenter/VPS (ASNs abaixo) são barrados pela regra "Vigia: fora
--    do Brasil" mesmo vindos do Brasil (bloquear_datacenter, padrão ligado).
-- Idempotente: não sobrescreve valores já escolhidos.
INSERT INTO vigia.config_geral (chave, valor) VALUES
  ('jev_limiar', '0.5'::jsonb),
  ('jev_exige_segunda', 'false'::jsonb),
  ('bloquear_datacenter', 'true'::jsonb)
ON CONFLICT (chave) DO NOTHING;

CREATE TABLE IF NOT EXISTS vigia.asn_datacenter (
  asn integer PRIMARY KEY CHECK (asn > 0),
  nome text NOT NULL,
  ativo boolean NOT NULL DEFAULT true
);

-- Só redes de hospedagem/nuvem. Fora de propósito:
--   AS174 (Cogent): trânsito IP, não hospeda clientes finais;
--   ISPs residenciais/móveis do Brasil (Vivo 26599/18881, Claro 28573,
--   TIM 26615, Oi 7738/8167, Algar 16735 etc.);
--   saídas do iCloud Private Relay (Akamai 36183, Cloudflare 13335).
-- Choopa é o ASN da Vultr (20473): uma linha só.
INSERT INTO vigia.asn_datacenter (asn, nome) VALUES
  (16509, 'Amazon AWS'),
  (14618, 'Amazon AWS (AES)'),
  (396982, 'Google Cloud'),
  (15169, 'Google'),
  (8075, 'Microsoft Azure'),
  (31898, 'Oracle Cloud'),
  (14061, 'DigitalOcean'),
  (63949, 'Linode/Akamai Cloud'),
  (20473, 'Vultr (Choopa)'),
  (16276, 'OVH'),
  (24940, 'Hetzner'),
  (213230, 'Hetzner Cloud'),
  (51167, 'Contabo'),
  (40021, 'Contabo (EUA)'),
  (45102, 'Alibaba Cloud'),
  (132203, 'Tencent Cloud'),
  (136907, 'Huawei Cloud'),
  (60781, 'Leaseweb (NL)'),
  (28753, 'Leaseweb (DE)'),
  (9009, 'M247'),
  (12876, 'Scaleway'),
  (47583, 'Hostinger'),
  (8560, 'IONOS'),
  (21859, 'Zenlayer'),
  (60068, 'DataCamp (CDN77)'),
  (199524, 'G-Core Labs')
ON CONFLICT (asn) DO NOTHING;
