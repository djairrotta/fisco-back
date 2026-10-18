-- Monitoramento da carteira: listas marcadas para acompanhar. Todo dia o
-- sistema compara cada empresa com a foto anterior (situacao, Simples,
-- MEI, divida federal, acordos) e gera alertas; o resumo vai por e-mail.
SET search_path TO fisco, public;

DO $m$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fisco.lista_importada'::regclass AND attname = 'monitorar' AND NOT attisdropped) THEN
    ALTER TABLE lista_importada ADD COLUMN monitorar boolean NOT NULL DEFAULT false;
  END IF;
END $m$;

CREATE TABLE IF NOT EXISTS monitor_foto (
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj          char(14) NOT NULL,
  situacao      smallint,
  opcao_simples boolean,
  opcao_mei     boolean,
  divida_total  numeric,
  inscricoes    bigint,
  rescindidas   bigint,
  ajuizada      boolean,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, cnpj)
);

CREATE TABLE IF NOT EXISTS monitor_alerta (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj       char(14) NOT NULL,
  tipo       text NOT NULL,     -- situacao | simples | mei | divida_nova | divida_subiu | divida_quitada | acordo_caiu | ajuizada
  texto      text NOT NULL,
  lido       boolean NOT NULL DEFAULT false,
  avisado    boolean NOT NULL DEFAULT false,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_monitor_alerta ON monitor_alerta (tenant_id, criado_em DESC);
