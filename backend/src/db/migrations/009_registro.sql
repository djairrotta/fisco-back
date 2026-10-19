-- Registro de atividade e erros (append-only). Um job diário remove linhas
-- com mais de 30 dias. Nunca guarda segredos, chaves, senhas nem corpo de
-- mensagem; assunto e endereços são permitidos.
CREATE TABLE correio.registro (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  nivel text NOT NULL CHECK (nivel IN ('info', 'aviso', 'erro')),
  area text NOT NULL CHECK (area IN (
    'envio', 'recebimento', 'imap', 'smtp', 'sieve', 'auth', 'sistema')),
  -- a linha sobrevive à remoção da caixa (log histórico)
  caixa_id int REFERENCES correio.caixas(id) ON DELETE SET NULL,
  mensagem text NOT NULL,
  detalhe jsonb
);

CREATE INDEX registro_ts_idx ON correio.registro (ts DESC, id DESC);
CREATE INDEX registro_area_ts_idx ON correio.registro (area, ts DESC);
CREATE INDEX registro_nivel_ts_idx ON correio.registro (nivel, ts DESC);
CREATE INDEX registro_caixa_ts_idx ON correio.registro (caixa_id, ts DESC);
