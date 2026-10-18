-- =====================================================================
-- Serie historica da divida ativa da PGFN (todos os trimestres publicados,
-- desde 2020). A tabela divida_inscricao guarda so a POSICAO ATUAL; aqui
-- fica a evolucao, que e o que mostra o momento da empresa:
--   * inscricao nova no trimestre  -> acabou de virar devedora (ou de novo)
--   * inscricao que saiu da lista  -> pagou, foi extinta ou cancelada
--   * situacao mudou               -> parcelou, ajuizou, rescindiu parcelamento
--   * valor por trimestre          -> divida crescendo ou caindo
--
-- So pessoa juridica e so devedor PRINCIPAL (somar corresponsavel duplica
-- o valor, aviso da propria PGFN). Duas tabelas, nao uma linha por
-- inscricao por trimestre: 26 trimestres x ~10 milhoes de inscricoes
-- seriam centenas de milhoes de linhas para responder perguntas que o
-- resumo por raiz + o ciclo de vida da inscricao respondem.
-- =====================================================================
SET search_path TO fisco, public;

-- Resumo por empresa (raiz), trimestre e base.
CREATE TABLE IF NOT EXISTS divida_trimestre (
  cnpj_raiz        char(8)       NOT NULL,
  data_ref         date          NOT NULL,      -- ultimo dia do trimestre
  origem           text          NOT NULL,      -- PGFN_GERAL | PGFN_PREV | PGFN_FGTS
  qtd              integer       NOT NULL,
  valor            numeric(18,2) NOT NULL,
  qtd_ajuizada     integer       NOT NULL DEFAULT 0,
  valor_ajuizado   numeric(18,2) NOT NULL DEFAULT 0,
  qtd_negociada    integer       NOT NULL DEFAULT 0,  -- parcelada, transacionada, suspensa, garantida
  qtd_rescindida   integer       NOT NULL DEFAULT 0,
  PRIMARY KEY (cnpj_raiz, data_ref, origem)
);
CREATE INDEX IF NOT EXISTS ix_div_tri_ref ON divida_trimestre (data_ref, origem);

-- Ciclo de vida de cada inscricao: quando apareceu, quando foi vista pela
-- ultima vez, valor e situacao na primeira e na ultima vez, e a ultima
-- MUDANCA de situacao (com o trimestre em que aconteceu).
CREATE TABLE IF NOT EXISTS divida_historico (
  origem             text          NOT NULL,
  numero_inscricao   text          NOT NULL,
  cnpj_raiz          char(8)       NOT NULL,
  uf                 char(2),
  receita            text,
  data_inscricao     date,
  primeiro_ref       date          NOT NULL,
  ultimo_ref         date          NOT NULL,
  valor_primeiro     numeric(18,2),
  valor_ultimo       numeric(18,2),
  situacao_primeira  text,
  situacao_ultima    text,
  ajuizado_ultimo    boolean,
  situacao_anterior  text,       -- situacao antes da ultima mudanca
  mudou_ref          date,       -- trimestre em que a situacao mudou pela ultima vez
  PRIMARY KEY (origem, numero_inscricao)
);
CREATE INDEX IF NOT EXISTS ix_div_hist_raiz     ON divida_historico (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_div_hist_primeiro ON divida_historico (primeiro_ref);
CREATE INDEX IF NOT EXISTS ix_div_hist_ultimo   ON divida_historico (ultimo_ref);
CREATE INDEX IF NOT EXISTS ix_div_hist_mudou    ON divida_historico (mudou_ref) WHERE mudou_ref IS NOT NULL;

-- Controle da carga historica: uma linha por trimestre e base.
CREATE TABLE IF NOT EXISTS pgfn_hist_carga (
  periodo       text        NOT NULL,     -- 2021_trimestre_03
  origem        text        NOT NULL,
  data_ref      date        NOT NULL,
  status        text        NOT NULL DEFAULT 'pendente',  -- pendente | carregando | ok | erro
  linhas        bigint,
  inscricoes    bigint,
  comecou_em    timestamptz,
  terminou_em   timestamptz,
  erro          text,
  PRIMARY KEY (periodo, origem)
);

-- Sinais por empresa, derivados da serie. Cada base e medida contra o
-- SEU ultimo trimestre carregado (a carga historica anda base a base; com
-- o ultimo global, uma base atrasada pareceria ter todas as inscricoes
-- "saindo"). So entra base com pelo menos 2 trimestres: com um so, tudo
-- seria "inscricao nova".
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_devedor_sinais AS
WITH ref AS (
  SELECT origem,
         max(data_ref) FILTER (WHERE status = 'ok') AS ultimo,
         min(data_ref) FILTER (WHERE status = 'ok') AS primeiro
    FROM pgfn_hist_carga GROUP BY origem
  HAVING count(*) FILTER (WHERE status = 'ok') >= 2
), h AS (
  SELECT h.*, r.ultimo, r.primeiro FROM divida_historico h JOIN ref r USING (origem)
), ins AS (
  SELECT cnpj_raiz,
    count(*)            FILTER (WHERE primeiro_ref = ultimo AND primeiro_ref > primeiro) AS novas_tri,
    coalesce(sum(valor_primeiro) FILTER (WHERE primeiro_ref = ultimo AND primeiro_ref > primeiro), 0) AS novas_tri_valor,
    count(*)            FILTER (WHERE primeiro_ref > ultimo - interval '1 year' AND primeiro_ref > primeiro) AS novas_12m,
    coalesce(sum(valor_primeiro) FILTER (WHERE primeiro_ref > ultimo - interval '1 year' AND primeiro_ref > primeiro), 0) AS novas_12m_valor,
    count(*)            FILTER (WHERE ultimo_ref < ultimo AND ultimo_ref >= ultimo - interval '1 year') AS saidas_12m,
    coalesce(sum(valor_ultimo) FILTER (WHERE ultimo_ref < ultimo AND ultimo_ref >= ultimo - interval '1 year'), 0) AS saidas_12m_valor,
    -- "Acordo caiu": a PGFN escreve RESCINDIDO em algumas bases; em outras
    -- (FGTS) a inscricao so volta de "INSCR PARCELADA" para "INSCRITA".
    count(*) FILTER (WHERE ultimo_ref = ultimo AND mudou_ref = ultimo AND (situacao_ultima ~* 'RESCIND|RESCISAO'
                       OR (coalesce(situacao_anterior,'') ~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI' AND situacao_ultima !~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI'))) AS rescindidas_tri,
    count(*) FILTER (WHERE ultimo_ref = ultimo AND mudou_ref > ultimo - interval '1 year' AND (situacao_ultima ~* 'RESCIND|RESCISAO'
                       OR (coalesce(situacao_anterior,'') ~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI' AND situacao_ultima !~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI'))) AS rescindidas_12m,
    count(*) FILTER (WHERE ultimo_ref = ultimo AND mudou_ref = ultimo AND situacao_ultima !~* 'RESCIND|RESCISAO'
                       AND situacao_ultima ~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI' AND coalesce(situacao_anterior,'') !~* 'NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI') AS negociadas_tri,
    count(*) FILTER (WHERE ultimo_ref = ultimo AND mudou_ref = ultimo AND situacao_ultima ~* 'AJUIZ'
                       AND coalesce(situacao_anterior, '') !~* 'AJUIZ') AS ajuizadas_tri,
    min(primeiro_ref) AS devedora_desde,
    max(ultimo) AS ref_ultimo
  FROM h GROUP BY cnpj_raiz
), val AS (
  SELECT t.cnpj_raiz,
         sum(t.valor) FILTER (WHERE t.data_ref = r.ultimo) AS valor_atual,
         sum(t.valor) FILTER (WHERE t.data_ref = (r.ultimo - interval '1 year')::date) AS valor_12m,
         count(DISTINCT t.data_ref) AS trimestres_com_divida
    FROM divida_trimestre t JOIN ref r USING (origem)
   GROUP BY t.cnpj_raiz
)
SELECT ins.*, coalesce(val.valor_atual, 0) AS valor_atual, coalesce(val.valor_12m, 0) AS valor_12m,
       CASE WHEN val.valor_12m > 0 THEN round((coalesce(val.valor_atual, 0) - val.valor_12m) / val.valor_12m * 100, 1) END AS variacao_12m_pct,
       coalesce(val.trimestres_com_divida, 0) AS trimestres_com_divida
  FROM ins LEFT JOIN val USING (cnpj_raiz);
CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_sinais ON mv_devedor_sinais (cnpj_raiz);
