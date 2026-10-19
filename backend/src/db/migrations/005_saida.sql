-- Caixa de saída (local ao Correio): envios agendados ("Enviar mais tarde")
-- e envios que falharam de forma transitória, reenviados com espera de
-- 1, 5 e 15 min antes de desistir (estado 'falhou'). Um item enviado sai
-- da tabela; os anexos (bytea) só existem enquanto o item está na fila.
CREATE TABLE correio.saida (
  id serial PRIMARY KEY,
  caixa_id int NOT NULL REFERENCES correio.caixas(id) ON DELETE CASCADE,
  -- pendente: aguardando proxima_tentativa; enviando: com o worker;
  -- falhou: desistiu (o usuário pode reenviar, editar ou cancelar)
  estado text NOT NULL DEFAULT 'pendente'
    CHECK (estado IN ('pendente', 'enviando', 'falhou')),
  -- agendado: "enviar mais tarde"; falha: envio imediato que falhou
  origem text NOT NULL CHECK (origem IN ('agendado', 'falha')),
  -- {para, cc, cco, assunto, html, texto?, respondendoA?, encaminhando?, incluirAssinatura}
  pedido jsonb NOT NULL,
  agendar_para timestamptz,
  proxima_tentativa timestamptz NOT NULL,
  tentativas int NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultimo_erro text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saida_devidas ON correio.saida (proxima_tentativa, id)
  WHERE estado = 'pendente';
CREATE INDEX saida_caixa ON correio.saida (caixa_id, id);

CREATE TABLE correio.saida_anexos (
  id serial PRIMARY KEY,
  saida_id int NOT NULL REFERENCES correio.saida(id) ON DELETE CASCADE,
  ordem int NOT NULL,
  nome text NOT NULL,
  tipo text NOT NULL,
  conteudo bytea NOT NULL,
  UNIQUE (saida_id, ordem)
);
