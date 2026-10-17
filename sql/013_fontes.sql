-- =====================================================================
-- Controle de fontes de dados e cache de divida estadual.
--
-- POR QUE NAO HA CARGA DIARIA DA PGFN: a PGFN publica TRIMESTRALMENTE.
-- Conferido na fonte: 2026_trimestre_03 ainda devolve 404, so existem o
-- 01 e o 02. Baixar 1,4 GB por dia para reprocessar o mesmo arquivo e
-- desperdicio de banda e de janela de manutencao. O agendador roda todo
-- dia, mas so SONDA; carrega quando a origem muda de fato.
--
-- DIVIDA ESTADUAL DE SP E MG NAO TEM DOWNLOAD EM MASSA. A PGE-SP publica
-- planilha agregada de estoque, nao lista de devedor. Em MG a Resolucao
-- Conjunta SEF/AGE 5.625/2022 manda publicar a lista, sem formato de
-- download definido. Nos dois casos o acesso util e consulta POR CNPJ
-- (Infosimples), entao estadual e enriquecimento sob demanda e fica
-- cacheado aqui, nao entra no mapa agregado.
-- =====================================================================
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS fonte_dados (
  chave           text PRIMARY KEY,      -- PGFN_GERAL, RECEITA_CNPJ, ...
  rotulo          text NOT NULL,
  periodicidade   text NOT NULL,         -- trimestral | mensal | sob_demanda
  versao_carregada text,                 -- 2026_trimestre_02 | 2026-09
  versao_disponivel text,                -- o que a sondagem encontrou
  ultima_sondagem timestamptz,
  ultima_carga    timestamptz,
  proxima_tentativa timestamptz,
  falhas_seguidas int NOT NULL DEFAULT 0,
  ultimo_erro     text
);

-- Rotulos sem travessao: eles vao direto para a tela do painel, e o
-- DESIGN.md proibe travessao na interface.
INSERT INTO fonte_dados (chave, rotulo, periodicidade) VALUES
  ('PGFN_GERAL',  'PGFN, dívida não previdenciária',  'trimestral'),
  ('PGFN_PREV',   'PGFN, dívida previdenciária',      'trimestral'),
  ('PGFN_FGTS',   'PGFN, FGTS',                       'trimestral'),
  ('RECEITA_CNPJ','Receita Federal, cadastro de CNPJ','mensal'),
  ('PGE_SP',      'PGE-SP, dívida ativa estadual',    'sob_demanda'),
  ('AGE_MG',      'AGE-MG, dívida ativa estadual',    'sob_demanda')
ON CONFLICT (chave) DO NOTHING;

-- Corrige rotulos ja gravados com travessao numa versao anterior.
UPDATE fonte_dados SET rotulo = replace(rotulo, ' — ', ', ') WHERE rotulo LIKE '%—%';

-- Cache da consulta estadual. TTL em vez de carga: cada consulta custa,
-- e o dado muda devagar.
CREATE TABLE IF NOT EXISTS divida_estadual (
  cnpj          char(14) NOT NULL,
  uf            char(2)  NOT NULL,       -- SP | MG
  tem_debito    boolean,
  valor_total   numeric(18,2),
  quantidade    int,
  detalhe       jsonb,
  fonte         text NOT NULL,           -- infosimples | apibrasil
  consultado_em timestamptz NOT NULL DEFAULT now(),
  erro          text,
  PRIMARY KEY (cnpj, uf)
);
CREATE INDEX IF NOT EXISTS ix_div_est_idade ON divida_estadual (consultado_em);
