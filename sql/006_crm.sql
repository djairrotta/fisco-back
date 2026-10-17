-- =====================================================================
-- CRM de leads juridicos. As decisoes de modelagem abaixo vieram da
-- leitura do Twenty (CRM open-source), adaptadas ao caso juridico.
-- =====================================================================
SET search_path TO fisco, public;

-- ---------------------------------------------------------------------
-- ATOR: quem mexeu e por qual via. Rastreabilidade e barata quando
-- nasce no schema; cara depois. (padrao ACTOR do Twenty)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ator_origem AS ENUM ('MANUAL','IMPORTACAO','API','SISTEMA','AGENTE_IA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- FUNIL: campo SELECT configuravel, NAO enum no codigo.
-- O escritorio ajusta as fases sem deploy.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS funil_opcao (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  valor       text NOT NULL,              -- token estavel: NOVO, CONTATADO...
  rotulo      text NOT NULL,              -- o que aparece na tela
  cor         text NOT NULL DEFAULT 'slate',
  posicao     double precision NOT NULL,
  visivel     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, valor)
);

-- ---------------------------------------------------------------------
-- LEAD. Dinheiro em MICROS (inteiro), nunca float — honorario e indebito
-- nao podem sofrer erro de ponto flutuante.
-- `extras` jsonb cobre campo customizado sem pagar o preco de um sistema
-- de metadata completo; o Twenty gasta metade da complexidade dele ali.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_juridico (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  cnpj              char(14),
  cpf               char(11),
  nome              text NOT NULL,
  tese_slug         text REFERENCES tese(slug),
  fase              text NOT NULL DEFAULT 'NOVO',
  posicao           double precision NOT NULL DEFAULT 1000,
  -- arrastar card grava UM update com posicao fracionaria entre os vizinhos,
  -- em vez de reindexar a coluna inteira
  honorario_micros  bigint,
  moeda             char(3) NOT NULL DEFAULT 'BRL',
  indebito_micros   bigint,
  probabilidade     smallint CHECK (probabilidade BETWEEN 0 AND 100),
  fecha_em          date,
  emails            jsonb NOT NULL DEFAULT '[]',
  telefones         jsonb NOT NULL DEFAULT '[]',
  extras            jsonb NOT NULL DEFAULT '{}',
  responsavel       text,
  criado_por_origem ator_origem NOT NULL DEFAULT 'MANUAL',
  criado_por_nome   text,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  removido_em       timestamptz,          -- soft delete em tudo
  busca             tsvector GENERATED ALWAYS AS (
                      to_tsvector('portuguese', coalesce(nome,'') || ' ' || coalesce(cnpj,''))
                    ) STORED
);
CREATE INDEX IF NOT EXISTS ix_lead_funil ON lead_juridico (tenant_id, fase, posicao)
  WHERE removido_em IS NULL;
CREATE INDEX IF NOT EXISTS ix_lead_busca ON lead_juridico USING gin (busca);
CREATE INDEX IF NOT EXISTS ix_lead_cnpj  ON lead_juridico (tenant_id, cnpj);

-- ---------------------------------------------------------------------
-- NOTAS, TAREFAS E ANEXOS via JUNCAO POLIMORFICA.
-- Uma anotacao pode apontar para lead, empresa, processo e peca ao mesmo
-- tempo, sem duplicar FK nem alterar schema a cada novo tipo.
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE alvo_tipo AS ENUM ('lead','empresa','processo','peca','ordem_calculo');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS anotacao (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  titulo      text,
  corpo       text,
  autor       text,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  removido_em timestamptz
);

CREATE TABLE IF NOT EXISTS tarefa (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  titulo        text NOT NULL,
  corpo         text,
  situacao      text NOT NULL DEFAULT 'A_FAZER',
  responsavel   text,
  vence_em      timestamptz,
  -- prazo processual: o que diferencia tarefa de escritorio de tarefa de CRM
  prazo_fatal   boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  concluida_em  timestamptz,
  removido_em   timestamptz
);
CREATE INDEX IF NOT EXISTS ix_tarefa_prazo ON tarefa (tenant_id, vence_em)
  WHERE removido_em IS NULL AND concluida_em IS NULL;

CREATE TABLE IF NOT EXISTS vinculo (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  anotacao_id uuid REFERENCES anotacao(id) ON DELETE CASCADE,
  tarefa_id   uuid REFERENCES tarefa(id) ON DELETE CASCADE,
  alvo_tipo   alvo_tipo NOT NULL,
  alvo_id     text NOT NULL,
  CHECK (num_nonnulls(anotacao_id, tarefa_id) = 1)
);
CREATE INDEX IF NOT EXISTS ix_vinculo_alvo ON vinculo (tenant_id, alvo_tipo, alvo_id);

-- ---------------------------------------------------------------------
-- LINHA DO TEMPO. Guarda o SNAPSHOT do tipo de evento e o NOME CACHEADO
-- do registro ligado: assim a timeline nao quebra se o tipo mudar nem
-- fica lenta por N joins.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evento_timeline (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  alvo_tipo       alvo_tipo NOT NULL,
  alvo_id         text NOT NULL,
  tipo            text NOT NULL,          -- criado, atualizado, vinculado...
  tipo_snapshot   jsonb NOT NULL DEFAULT '{}',
  propriedades    jsonb NOT NULL DEFAULT '{}',  -- diff antes/depois
  ligado_tipo     alvo_tipo,
  ligado_id       text,
  ligado_nome     text,                   -- denormalizado de proposito
  autor_origem    ator_origem NOT NULL DEFAULT 'MANUAL',
  autor_nome      text,
  aconteceu_em    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_tl_alvo ON evento_timeline
  (tenant_id, alvo_tipo, alvo_id, aconteceu_em DESC);

-- ---------------------------------------------------------------------
-- VIEWS SALVAS: filtro, ordenacao e colunas de kanban como DADO.
-- O grupo de filtro e uma arvore, para permitir "A E (B OU C)".
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visao (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome            text NOT NULL,
  objeto          text NOT NULL DEFAULT 'lead',
  tipo            text NOT NULL DEFAULT 'TABELA',   -- TABELA | KANBAN
  agrupa_por      text,                             -- campo que vira coluna
  agregacao       text,                             -- SOMA, CONTA...
  agregacao_campo text,
  posicao         double precision NOT NULL DEFAULT 1000,
  criado_em       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS visao_filtro_grupo (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visao_id  uuid NOT NULL REFERENCES visao(id) ON DELETE CASCADE,
  pai_id    uuid REFERENCES visao_filtro_grupo(id) ON DELETE CASCADE,
  operador  text NOT NULL DEFAULT 'E',    -- E | OU | NAO
  posicao   double precision NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS visao_filtro (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visao_id  uuid NOT NULL REFERENCES visao(id) ON DELETE CASCADE,
  grupo_id  uuid REFERENCES visao_filtro_grupo(id) ON DELETE CASCADE,
  campo     text NOT NULL,
  operando  text NOT NULL,                -- IGUAL, CONTEM, MAIOR_QUE...
  valor     jsonb NOT NULL DEFAULT 'null',
  posicao   double precision NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS visao_ordenacao (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visao_id  uuid NOT NULL REFERENCES visao(id) ON DELETE CASCADE,
  campo     text NOT NULL,
  direcao   text NOT NULL DEFAULT 'ASC'
);

-- colunas do kanban como linha: o usuario reordena e esconde coluna sem
-- mexer nas opcoes do campo
CREATE TABLE IF NOT EXISTS visao_grupo (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visao_id    uuid NOT NULL REFERENCES visao(id) ON DELETE CASCADE,
  valor_campo text NOT NULL,
  visivel     boolean NOT NULL DEFAULT true,
  posicao     double precision NOT NULL DEFAULT 1000
);

-- ---------------------------------------------------------------------
-- Funil padrao do escritorio tributario, criado junto com o tenant
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION semear_funil(p_tenant uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO funil_opcao (tenant_id, valor, rotulo, cor, posicao) VALUES
    (p_tenant, 'NOVO',        'Novo',                 'slate',   0),
    (p_tenant, 'DIAGNOSTICO', 'Diagnóstico',          'sky',     1),
    (p_tenant, 'CONTATADO',   'Contatado',            'violet',  2),
    (p_tenant, 'REUNIAO',     'Reunião marcada',      'amber',   3),
    (p_tenant, 'PROPOSTA',    'Proposta enviada',     'orange',  4),
    (p_tenant, 'CONTRATADO',  'Contrato assinado',    'emerald', 5),
    (p_tenant, 'PROTOCOLADO', 'Ação protocolada',     'teal',    6),
    (p_tenant, 'PERDIDO',     'Perdido',              'red',     7)
  ON CONFLICT (tenant_id, valor) DO NOTHING;
$$;
