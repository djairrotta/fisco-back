-- =====================================================================
-- Camada de processos: iAndamento descobre, DataJud enriquece.
--
-- A descoberta e o pulo do gato. O DataJud NAO expoe nome de parte (o CNJ
-- bloqueia por protecao de dados), entao ele nunca encontra processo a
-- partir de um CNPJ. O iAndamento faz essa ponte: busca por CNPJ ou CPF e
-- devolve os numeros. Com o numero em maos, o DataJud entrega classe,
-- assunto, orgao, valor da causa e a linha do tempo completa.
-- =====================================================================
SET search_path TO fisco, public;

ALTER TABLE processo
  ADD COLUMN IF NOT EXISTS grau            text,
  ADD COLUMN IF NOT EXISTS sistema         text,
  ADD COLUMN IF NOT EXISTS nivel_sigilo    smallint,
  ADD COLUMN IF NOT EXISTS polo            text,     -- ATIVO | PASSIVO
  ADD COLUMN IF NOT EXISTS assuntos        jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS descoberto_por  text,     -- iandamento | djen | manual
  ADD COLUMN IF NOT EXISTS enriquecido_em  timestamptz;

-- Linha do tempo processual, movimento a movimento (vem do DataJud).
-- Tabela propria e nao jsonb no processo: o advogado filtra por codigo de
-- movimento ("houve penhora?") e isso em jsonb fica caro.
CREATE TABLE IF NOT EXISTS processo_movimento (
  id             bigserial PRIMARY KEY,
  numero_cnj     char(20) NOT NULL REFERENCES processo(numero_cnj) ON DELETE CASCADE,
  codigo         int,                    -- TPU do CNJ
  nome           text,
  data_hora      timestamptz NOT NULL,
  complementos   jsonb NOT NULL DEFAULT '[]',
  orgao_julgador text,
  UNIQUE (numero_cnj, codigo, data_hora)
);
CREATE INDEX IF NOT EXISTS ix_mov_proc ON processo_movimento (numero_cnj, data_hora DESC);
CREATE INDEX IF NOT EXISTS ix_mov_codigo ON processo_movimento (codigo);

-- Publicacoes do DJEN (monitor diario por nome da parte e por OAB)
CREATE TABLE IF NOT EXISTS publicacao (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid REFERENCES tenant(id) ON DELETE CASCADE,
  hash_djen      text UNIQUE,
  numero_cnj     char(20),
  tribunal       text,
  orgao          text,
  tipo           text,
  texto          text,
  disponibilizada_em date,
  destinatarios  jsonb NOT NULL DEFAULT '[]',
  advogados      jsonb NOT NULL DEFAULT '[]',
  -- classificacao feita pelo Jev (TypeSafe), nao por LLM
  classe_jev     text,
  prazo_dias     smallint,
  lida           boolean NOT NULL DEFAULT false,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pub_tenant ON publicacao (tenant_id, disponibilizada_em DESC)
  WHERE NOT lida;
CREATE INDEX IF NOT EXISTS ix_pub_proc ON publicacao (numero_cnj);

-- Monitores: o que cada assinante acompanha
CREATE TABLE IF NOT EXISTS monitor (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  tipo        text NOT NULL,            -- cnpj | cpf | oab | nome | processo
  valor       text NOT NULL,
  canais      text[] NOT NULL DEFAULT ARRAY['email'],  -- email, whatsapp, push
  ativo       boolean NOT NULL DEFAULT true,
  ultima_checagem timestamptz,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tipo, valor)
);
