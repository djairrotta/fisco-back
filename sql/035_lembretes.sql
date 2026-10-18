-- Lembretes do CRM por e-mail: resumo diario (7h de Brasilia) com os
-- proximos passos de hoje e os atrasados. Uma vez por dia por usuario.
SET search_path TO fisco, public;

DO $u$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'fisco.usuario'::regclass AND attname = 'lembrete_email' AND NOT attisdropped) THEN
    ALTER TABLE usuario ADD COLUMN lembrete_email boolean NOT NULL DEFAULT true;
  END IF;
END $u$;

CREATE TABLE IF NOT EXISTS lembrete_envio (
  usuario_id uuid NOT NULL,
  dia        date NOT NULL,
  itens      integer NOT NULL,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, dia)
);
