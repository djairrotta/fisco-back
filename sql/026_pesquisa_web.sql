-- Pesquisa na internet (servico Jev). Uma linha por CNPJ: o resultado vale
-- para todos os escritorios (e dado publico do site da empresa) e fica em
-- cache 30 dias, porque cada pesquisa abre um navegador e custa chamada de
-- modelo.
CREATE TABLE IF NOT EXISTS fisco.pesquisa_web (
  cnpj        char(14) PRIMARY KEY,
  dados       jsonb NOT NULL,
  status      text NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
