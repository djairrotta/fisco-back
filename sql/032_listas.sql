-- Listas importadas (CNPJs colados ou de arquivo) e a fila de
-- enriquecimento pela internet (Jev), uma empresa por vez.
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS lista_importada (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  cnpjs       text[] NOT NULL,
  invalidos   integer NOT NULL DEFAULT 0,
  criado_por  uuid,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_lista_tenant ON lista_importada (tenant_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS fila_internet (
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj        char(14) NOT NULL,
  lista_id    uuid REFERENCES lista_importada(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'pendente',     -- pendente | feito | erro
  erro        text,
  tentativas  smallint NOT NULL DEFAULT 0,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  feito_em    timestamptz,
  PRIMARY KEY (tenant_id, cnpj)
);
CREATE INDEX IF NOT EXISTS ix_fila_internet_pend ON fila_internet (criado_em) WHERE status = 'pendente';
