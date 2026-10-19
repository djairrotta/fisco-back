-- O mesmo UID volta a valer outra mensagem quando a UIDVALIDITY da pasta
-- muda: a chave do cache de vereditos passa a incluí-la. Vereditos antigos
-- (sem uidvalidity) são descartados; voltam a ser calculados sob demanda.
DELETE FROM correio.classificacoes;
ALTER TABLE correio.classificacoes ADD COLUMN uidvalidity bigint NOT NULL;
ALTER TABLE correio.classificacoes DROP CONSTRAINT classificacoes_pkey;
ALTER TABLE correio.classificacoes
  ADD PRIMARY KEY (caixa_id, pasta, uidvalidity, uid);
