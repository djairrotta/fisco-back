-- CNPJ alfanumerico (Receita, desde julho/2026): os 12 primeiros caracteres
-- aceitam A-Z. A constraint antiga (017) exigia 14 digitos e faria a carga
-- da PGFN inteira falhar na primeira linha com CNPJ novo. NOT VALID: vale
-- para linha nova, sem varrer a tabela. Troca uma vez so.
SET search_path TO fisco, public;
DO $alnum$
BEGIN
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'ck_documento'
                            AND conrelid = 'fisco.divida_inscricao'::regclass)) LIKE '%0-9A-Z%' THEN
    RETURN;
  END IF;
  ALTER TABLE divida_inscricao DROP CONSTRAINT IF EXISTS ck_documento;
  ALTER TABLE divida_inscricao ADD CONSTRAINT ck_documento CHECK (
    (tipo_pessoa = 'PJ' AND documento ~ '^[0-9A-Z]{12}[0-9]{2}$' AND cnpj_raiz IS NOT NULL) OR
    (tipo_pessoa = 'PF' AND cnpj_raiz IS NULL)
  ) NOT VALID;
END $alnum$;
