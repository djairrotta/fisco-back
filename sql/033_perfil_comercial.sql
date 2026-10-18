-- Perfil comercial do escritorio: o que oferece, para quem, onde e a
-- assinatura. Alimenta a IA (objetivos e mensagens) e os modelos de envio.
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS perfil_comercial (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  oferta        text,
  publico       text,
  regiao        text,
  assinatura    text,
  site          text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
