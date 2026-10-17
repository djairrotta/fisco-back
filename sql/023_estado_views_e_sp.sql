-- =====================================================================
-- 023:
--  1. views_estado: quando as views foram recalculadas pela ultima vez.
--     O boot compara com o fim da ultima carga e recalcula se a carga for
--     mais nova. Sem isto, uma carga que terminou e o container reiniciou
--     antes do recalculo ficava invisivel ate a carga SEGUINTE (visto em
--     producao: a base previdenciaria carregada e o painel mostrando so FGTS).
--  2. estadual_transacao_sp: a UNICA base estadual publicada em lote em SP
--     (Dados Abertos SP, "Divida Ativa do Estado de Sao Paulo"): quem
--     ADERIU a transacao da PGE-SP, com status e valores. Nao e a divida
--     ativa estadual inteira -- e o recorte de quem negociou.
-- =====================================================================
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS views_estado (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  atualizado_em  timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO views_estado (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS estadual_transacao_sp (
  id                  bigserial PRIMARY KEY,
  cnpj                varchar(14) NOT NULL,
  cnpj_raiz           char(8) NOT NULL,
  nome                text,
  edital              text NOT NULL,
  solicitacao         text,
  status              text,
  tipo_debito         text,
  qtd_debitos         int,
  qtd_parcelas        int,
  valor_sem_beneficio numeric(18,2),
  valor_com_beneficio numeric(18,2),
  data_solicitacao    date,
  posicao             date NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_est_sp_raiz ON estadual_transacao_sp (cnpj_raiz);
