-- Veredito do classificador (OpenRouter) por mensagem: cache para o selo de
-- suspeita no detalhe e para o aviso no push. Sem veredito = sem linha.
CREATE TABLE correio.classificacoes (
  caixa_id int NOT NULL REFERENCES correio.caixas(id) ON DELETE CASCADE,
  pasta text NOT NULL,
  uid bigint NOT NULL,
  classe text NOT NULL CHECK (classe IN ('ok', 'spam', 'phishing')),
  confianca real NOT NULL CHECK (confianca >= 0 AND confianca <= 1),
  motivo text NOT NULL DEFAULT '' CHECK (char_length(motivo) <= 200),
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caixa_id, pasta, uid)
);
