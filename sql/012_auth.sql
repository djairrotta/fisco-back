-- =====================================================================
-- Autenticacao. Nao existia: `tenant` guardava e-mail mas nenhuma senha,
-- e nao havia tabela de usuario -- por isso /app nao tinha login.
--
-- Um tenant (escritorio) tem N usuarios, porque o concorrente vende por
-- numero de pessoas do escritorio e nos vamos precisar do mesmo recorte.
--
-- A senha e guardada como scrypt (N=16384, r=8, p=1) com sal por usuario,
-- no formato scrypt$<sal_hex>$<hash_hex>. scrypt e nativo do Node: zero
-- dependencia de terceiro no caminho mais sensivel do sistema.
-- =====================================================================
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS usuario (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome         text NOT NULL,
  email        text NOT NULL,
  senha_hash   text NOT NULL,
  papel        text NOT NULL DEFAULT 'membro',   -- dono | membro
  ativo        boolean NOT NULL DEFAULT true,
  ultimo_login timestamptz,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_usuario_email ON usuario (lower(email));
CREATE INDEX IF NOT EXISTS ix_usuario_tenant ON usuario (tenant_id);

-- Limite de usuarios por plano, como o concorrente faz.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS usuarios_max int NOT NULL DEFAULT 1;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS cidades_max  int NOT NULL DEFAULT 1;

-- Tentativas de login: trava forca bruta sem depender de memoria do
-- processo, que morre a cada deploy.
CREATE TABLE IF NOT EXISTS tentativa_login (
  id        bigserial PRIMARY KEY,
  email     text NOT NULL,
  ip        text,
  sucesso   boolean NOT NULL,
  em        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tentativa ON tentativa_login (lower(email), em DESC);
