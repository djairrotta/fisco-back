-- Particoes por UF. Sem isto, um filtro de cidade varre a tabela inteira.
SET search_path TO fisco, public;
DO $$
DECLARE u text;
BEGIN
  FOREACH u IN ARRAY ARRAY['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT',
                           'MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO',
                           'RR','SC','SP','SE','TO'] LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS estabelecimento_%s PARTITION OF estabelecimento FOR VALUES IN (%L)',
      lower(u), u);
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS divida_%s PARTITION OF divida_inscricao FOR VALUES IN (%L)',
      lower(u), u);
  END LOOP;
END $$;
