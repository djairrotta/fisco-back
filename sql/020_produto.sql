-- =====================================================================
-- 020: o produto de verdade em cima da base.
--
--   mv_devedor     uma linha por EMPRESA devedora (raiz do CNPJ), com o
--                  cadastro da Receita quando existe. E a tabela da
--                  pesquisa, dos leads e do painel.
--   empresa_cache  consulta de CNPJ sob demanda (BrasilAPI), para o lead
--                  ter telefone e e-mail mesmo antes da carga da Receita.
--   lead_juridico  ganha os campos que a ficha e o kanban mostram.
--   quadro/cartao  kanban livre de planejamento.
--   nota           paginas estilo Notion, em arvore.
--   busca_salva    filtros de pesquisa guardados.
--
-- REGRA DESTE ARQUIVO: roda no boot de TODO deploy. Nada aqui pode ler a
-- base grande. Por isso a mv_devedor nasce WITH NO DATA: com dado, o
-- CREATE leria 30 milhoes de inscricoes dentro do statement_timeout do
-- boot, estouraria, e a migracao ficaria pendente para sempre. Quem
-- preenche e o servidor, em segundo plano, logo depois de subir.
-- =====================================================================
SET search_path TO fisco, public;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_devedor AS
WITH d AS (
  SELECT
    i.cnpj_raiz,
    mode() WITHIN GROUP (ORDER BY i.uf)                AS uf,
    mode() WITHIN GROUP (ORDER BY i.nome_devedor)      AS nome,
    min(i.documento)                                   AS cnpj_pgfn,
    count(*)                                           AS qtd_inscricoes,
    sum(i.valor_consolidado)                           AS valor_total,
    coalesce(sum(i.valor_consolidado) FILTER (WHERE i.ajuizado), 0) AS valor_ajuizado,
    min(i.data_inscricao)                              AS inscricao_mais_antiga,
    max(i.data_inscricao)                              AS inscricao_mais_recente,
    max(i.data_referencia)                             AS data_referencia,
    mode() WITHIN GROUP (ORDER BY i.tributo)           AS tributo_principal,
    array_agg(DISTINCT i.tributo) FILTER (WHERE i.tributo IS NOT NULL) AS tributos,
    array_agg(DISTINCT i.origem::text)                 AS origens,
    coalesce(bool_or(i.ajuizado), false)               AS tem_ajuizada
  FROM divida_inscricao i
  WHERE i.tipo_pessoa = 'PJ' AND i.tipo_devedor = 1 AND i.cnpj_raiz IS NOT NULL
  GROUP BY i.cnpj_raiz
)
SELECT DISTINCT ON (d.cnpj_raiz)
  d.*,
  coalesce(e.cnpj, d.cnpj_pgfn)   AS cnpj,
  e.nome_fantasia, e.situacao, e.data_abertura, e.cnae_principal,
  e.municipio_ibge, e.municipio,
  e.cep, e.logradouro, e.numero, e.bairro,
  nullif(e.telefone, '') AS telefone,
  nullif(e.email, '')    AS email,
  (e.cnpj IS NOT NULL)   AS tem_cadastro,
  nome_chave(coalesce(d.nome, '') || ' ' || coalesce(e.nome_fantasia, '')
             || ' ' || d.cnpj_raiz) AS busca
FROM d
LEFT JOIN estabelecimento e ON e.cnpj_raiz = d.cnpj_raiz AND e.matriz
ORDER BY d.cnpj_raiz, e.atualizado_em DESC NULLS LAST
WITH NO DATA;

CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_devedor      ON mv_devedor (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_mv_devedor_valor        ON mv_devedor (valor_total DESC);
CREATE INDEX IF NOT EXISTS ix_mv_devedor_uf_valor     ON mv_devedor (uf, valor_total DESC);
CREATE INDEX IF NOT EXISTS ix_mv_devedor_mun          ON mv_devedor (municipio_ibge, valor_total DESC);
CREATE INDEX IF NOT EXISTS ix_mv_devedor_busca        ON mv_devedor USING gin (busca gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_mv_devedor_tributos     ON mv_devedor USING gin (tributos);
CREATE INDEX IF NOT EXISTS ix_mv_devedor_cnae         ON mv_devedor (cnae_principal);

-- ---------------------------------------------------------------------
-- Cache da consulta de CNPJ sob demanda.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS empresa_cache (
  cnpj        varchar(14) PRIMARY KEY,
  fonte       text NOT NULL,
  dados       jsonb NOT NULL,
  buscado_em  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Lead: o que o kanban e a lista mostram sem precisar de join na base
-- grande (que muda a cada trimestre; o lead e do escritorio).
-- ---------------------------------------------------------------------
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS uf                char(2);
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS municipio         text;
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS divida_total      numeric(18,2);
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS tributo_principal text;
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS etiquetas         text[] NOT NULL DEFAULT '{}';
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS proximo_passo     text;
ALTER TABLE lead_juridico ADD COLUMN IF NOT EXISTS proximo_em        date;
-- CNPJ alfanumerico tem letra; char(14) ja aceita, so documentando.
CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_tenant_cnpj
  ON lead_juridico (tenant_id, cnpj) WHERE removido_em IS NULL AND cnpj IS NOT NULL;

-- ---------------------------------------------------------------------
-- Kanban livre. Posicao fracionaria: arrastar grava UM update.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quadro (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  titulo      text NOT NULL,
  icone       text,
  posicao     double precision NOT NULL DEFAULT 1000,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz
);
CREATE INDEX IF NOT EXISTS ix_quadro_tenant ON quadro (tenant_id, posicao) WHERE removido_em IS NULL;

CREATE TABLE IF NOT EXISTS quadro_coluna (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quadro_id uuid NOT NULL REFERENCES quadro(id) ON DELETE CASCADE,
  titulo    text NOT NULL,
  cor       text NOT NULL DEFAULT 'slate',
  posicao   double precision NOT NULL DEFAULT 1000
);
CREATE INDEX IF NOT EXISTS ix_qcol_quadro ON quadro_coluna (quadro_id, posicao);

CREATE TABLE IF NOT EXISTS cartao (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  quadro_id     uuid NOT NULL REFERENCES quadro(id) ON DELETE CASCADE,
  coluna_id     uuid NOT NULL REFERENCES quadro_coluna(id) ON DELETE CASCADE,
  titulo        text NOT NULL,
  conteudo      jsonb NOT NULL DEFAULT '[]',   -- blocos do editor
  etiquetas     text[] NOT NULL DEFAULT '{}',
  vence_em      date,
  concluido     boolean NOT NULL DEFAULT false,
  lead_id       uuid REFERENCES lead_juridico(id) ON DELETE SET NULL,
  posicao       double precision NOT NULL DEFAULT 1000,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  removido_em   timestamptz
);
CREATE INDEX IF NOT EXISTS ix_cartao_coluna ON cartao (coluna_id, posicao) WHERE removido_em IS NULL;

-- ---------------------------------------------------------------------
-- Notas estilo Notion: pagina dentro de pagina, conteudo em blocos.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nota (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pai_id        uuid REFERENCES nota(id) ON DELETE CASCADE,
  titulo        text NOT NULL DEFAULT '',
  icone         text,
  conteudo      jsonb NOT NULL DEFAULT '[]',
  texto         text NOT NULL DEFAULT '',      -- texto puro, para busca
  lead_id       uuid REFERENCES lead_juridico(id) ON DELETE SET NULL,
  cnpj          varchar(14),
  favorita      boolean NOT NULL DEFAULT false,
  posicao       double precision NOT NULL DEFAULT 1000,
  criado_por    uuid REFERENCES usuario(id) ON DELETE SET NULL,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  removido_em   timestamptz
);
CREATE INDEX IF NOT EXISTS ix_nota_arvore ON nota (tenant_id, pai_id, posicao) WHERE removido_em IS NULL;
CREATE INDEX IF NOT EXISTS ix_nota_cnpj   ON nota (tenant_id, cnpj) WHERE removido_em IS NULL;
CREATE INDEX IF NOT EXISTS ix_nota_texto  ON nota USING gin (texto gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Pesquisas salvas.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS busca_salva (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome       text NOT NULL,
  filtros    jsonb NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_busca_salva ON busca_salva (tenant_id, criado_em DESC);
