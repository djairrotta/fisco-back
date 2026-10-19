-- Contas Resend gerenciadas pelo app (além das variáveis RESEND_CONTA_*).
-- A API key fica cifrada no cofre (v1:iv:ct), como as senhas das caixas.
-- Regras de "no máximo 20 contas ativas" e "um domínio em uma só conta ativa"
-- são aplicadas na camada de repositório (transação + advisory lock).
CREATE TABLE correio.resend_contas (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  apikey_cifrada text NOT NULL,
  dominios text[] NOT NULL DEFAULT '{}',
  ativo boolean NOT NULL DEFAULT true,
  verificado boolean NOT NULL DEFAULT false,
  testado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Busca por domínio (envio resolve a conta ativa que verifica o domínio).
CREATE INDEX resend_contas_dominios_idx
  ON correio.resend_contas USING gin (dominios);
