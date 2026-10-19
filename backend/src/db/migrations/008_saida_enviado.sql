-- Caixa de saída: depois que o SMTP aceita, o item vira 'enviado' (com o
-- Message-ID) ANTES da limpeza; assim uma limpeza que falha nunca causa
-- reenvio. 'enviado' é interno e não aparece na API.
ALTER TABLE correio.saida DROP CONSTRAINT saida_estado_check;
ALTER TABLE correio.saida ADD CONSTRAINT saida_estado_check
  CHECK (estado IN ('pendente', 'enviando', 'falhou', 'enviado'));
ALTER TABLE correio.saida ADD COLUMN message_id text;
