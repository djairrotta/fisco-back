SET search_path TO fisco, public;

-- Mapa e lista: filtro sempre por municipio + situacao ativa
CREATE INDEX IF NOT EXISTS ix_estab_municipio ON estabelecimento (uf, municipio_ibge)
  WHERE situacao = 2;
CREATE INDEX IF NOT EXISTS ix_estab_cnae      ON estabelecimento (uf, cnae_principal)
  WHERE situacao = 2;
CREATE INDEX IF NOT EXISTS ix_estab_raiz      ON estabelecimento (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_estab_razao_trgm ON estabelecimento
  USING gin (razao_social gin_trgm_ops);

-- Divida: o join com cadastro e sempre pela raiz do CNPJ, porque a
-- inscricao fica no CNPJ que originou o debito, nem sempre a matriz.
CREATE INDEX IF NOT EXISTS ix_div_raiz    ON divida_inscricao (cnpj_raiz)
  WHERE tipo_devedor = 1;
CREATE INDEX IF NOT EXISTS ix_div_tributo ON divida_inscricao (uf, tributo)
  WHERE tipo_devedor = 1;
-- BRIN: data_inscricao entra ordenada na carga; indice 100x menor que btree
CREATE INDEX IF NOT EXISTS ix_div_data    ON divida_inscricao USING brin (data_inscricao);
CREATE INDEX IF NOT EXISTS ix_div_valor   ON divida_inscricao (uf, valor_consolidado DESC)
  WHERE tipo_devedor = 1;

CREATE INDEX IF NOT EXISTS ix_proc_raiz ON processo (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_lead_tenant ON lead (tenant_id, estagio);
CREATE INDEX IF NOT EXISTS ix_peca_tenant ON peca (tenant_id, criada_em DESC);
