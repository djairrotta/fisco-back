-- Envio em massa (e-mail pelo Resend, WhatsApp pelo open-wa) para empresas
-- de uma pesquisa ou lista: modelos, campanhas, fila de envio, descadastro.
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS modelo_mensagem (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome       text NOT NULL,
  canal      text NOT NULL CHECK (canal IN ('email', 'whatsapp')),
  assunto    text,
  corpo      text NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_modelo_tenant ON modelo_mensagem (tenant_id, atualizado_em DESC);

CREATE TABLE IF NOT EXISTS campanha (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  nome          text NOT NULL,
  canal         text NOT NULL CHECK (canal IN ('email', 'whatsapp')),
  assunto       text,
  corpo         text NOT NULL,
  origem        jsonb NOT NULL,                 -- {filtros} | {lista_id} | {cnpjs}
  status        text NOT NULL DEFAULT 'rascunho', -- rascunho|preparada|enviando|pausada|concluida|cancelada
  limite_dia    integer NOT NULL DEFAULT 200,
  intervalo_s   integer NOT NULL DEFAULT 20,
  janela_ini    smallint NOT NULL DEFAULT 8,    -- hora local de inicio
  janela_fim    smallint NOT NULL DEFAULT 19,
  so_dias_uteis boolean NOT NULL DEFAULT true,
  ocultar_contador boolean NOT NULL DEFAULT true,
  remetente_nome text,
  responder_para text,
  criado_por    uuid,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  iniciada_em   timestamptz,
  concluida_em  timestamptz,
  ultimo_envio  timestamptz
);
CREATE INDEX IF NOT EXISTS ix_campanha_tenant ON campanha (tenant_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_campanha_ativa ON campanha (status) WHERE status = 'enviando';

CREATE TABLE IF NOT EXISTS campanha_envio (
  id           bigserial PRIMARY KEY,
  campanha_id  uuid NOT NULL REFERENCES campanha(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL,
  cnpj         char(14) NOT NULL,
  destino      text NOT NULL,
  dados        jsonb,                           -- campos para o modelo
  status       text NOT NULL DEFAULT 'pendente', -- pendente|enviado|erro|descadastrado|cancelado
  erro         text,
  id_externo   text,
  enviado_em   timestamptz,
  UNIQUE (campanha_id, destino)
);
CREATE INDEX IF NOT EXISTS ix_envio_pend ON campanha_envio (campanha_id, id) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS ix_envio_dia ON campanha_envio (tenant_id, enviado_em) WHERE status = 'enviado';

CREATE TABLE IF NOT EXISTS descadastro (
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  destino    text NOT NULL,                     -- e-mail minusculo ou telefone so digitos
  canal      text NOT NULL,
  origem     text NOT NULL DEFAULT 'link',      -- link | manual | resposta
  criado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, destino)
);
