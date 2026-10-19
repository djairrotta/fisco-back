-- As chaves da Resend passam a viver SÓ no ambiente (RESEND_CONTA_1..20);
-- o banco guarda apenas o mapeamento domínio→slot. Supera a 010: remove a
-- tabela antiga (que tinha a chave cifrada) para não deixar coluna de chave
-- no schema vivo.
DROP TABLE IF EXISTS correio.resend_contas;

-- Rótulo por slot (1..20). NUNCA guarda chave.
CREATE TABLE correio.resend_contas (
  slot int PRIMARY KEY CHECK (slot BETWEEN 1 AND 20),
  nome text NOT NULL DEFAULT ''
);

-- Mapeamento domínio→slot. Um domínio só pode estar ativo em um slot.
CREATE TABLE correio.resend_dominios (
  id serial PRIMARY KEY,
  slot int NOT NULL CHECK (slot BETWEEN 1 AND 20),
  dominio text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX resend_dominios_ativo_uq
  ON correio.resend_dominios (dominio) WHERE ativo;
CREATE INDEX resend_dominios_slot_idx
  ON correio.resend_dominios (slot) WHERE ativo;
