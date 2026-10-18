-- Historico de pesquisas de empresas: cada pesquisa feita (pagina 1) vira
-- um cartao com os filtros, o total e a data. Mesma pesquisa no mesmo dia
-- so atualiza o cartao (chave = md5 dos filtros).
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS busca_historico (
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  usuario_id  uuid NOT NULL,
  chave       text NOT NULL,
  filtros     jsonb NOT NULL,
  total       integer,
  excede      boolean NOT NULL DEFAULT false,
  vezes       integer NOT NULL DEFAULT 1,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  usado_em    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usuario_id, chave)
);
CREATE INDEX IF NOT EXISTS ix_busca_hist_uso ON busca_historico (tenant_id, usuario_id, usado_em DESC);

-- Registro das exportacoes (quem, quando, quantas linhas): auditoria e,
-- mais tarde, limite por plano.
CREATE TABLE IF NOT EXISTS busca_exportacao (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  usuario_id  uuid,
  formato     text NOT NULL,
  linhas      integer NOT NULL,
  colunas     text[],
  filtros     jsonb,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_busca_exp ON busca_exportacao (tenant_id, criado_em DESC);
