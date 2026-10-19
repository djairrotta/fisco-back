-- Estúdio de assinatura (2.0): várias assinaturas por caixa, com um padrão
-- para mensagens novas e outro para respostas/encaminhamentos.
CREATE TABLE correio.assinaturas (
  id serial PRIMARY KEY,
  caixa_id int NOT NULL REFERENCES correio.caixas(id) ON DELETE CASCADE,
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 100),
  modelo text NOT NULL
    CHECK (modelo IN ('classico', 'executivo', 'moderno', 'minimalista')),
  -- {nome, cargo, empresa, registro, telefone, whatsapp, email, site,
  --  endereco, redes{linkedin,instagram,facebook,x,youtube}, aviso,
  --  logo: caixa|propria|nenhum, corDestaque, divisor: linha|nenhum|barra}
  campos jsonb NOT NULL DEFAULT '{}',
  -- logo próprio (PNG/JPEG/WebP, até 2 MB), usado com campos.logo = 'propria'
  logo bytea,
  logo_tipo text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assinaturas_caixa ON correio.assinaturas (caixa_id, id);

ALTER TABLE correio.caixas
  ADD COLUMN assinatura_nova_id int
    REFERENCES correio.assinaturas(id) ON DELETE SET NULL,
  ADD COLUMN assinatura_resposta_id int
    REFERENCES correio.assinaturas(id) ON DELETE SET NULL;

-- A assinatura 1.0 (campos em caixas.assinatura) vira uma "Clássico", padrão
-- para novas e respostas. `extra` (texto livre do 1.0) vai para `registro`.
-- Sem aviso, para o e-mail enviado continuar igual ao do 1.0.
WITH antigas AS (
  SELECT id AS caixa_id, assinatura AS a
  FROM correio.caixas
  WHERE coalesce(nullif(btrim(assinatura->>'nome'), ''),
                 nullif(btrim(assinatura->>'cargo'), ''),
                 nullif(btrim(assinatura->>'telefone'), ''),
                 nullif(btrim(assinatura->>'site'), ''),
                 nullif(btrim(assinatura->>'extra'), '')) IS NOT NULL
), novas AS (
  INSERT INTO correio.assinaturas (caixa_id, nome, modelo, campos)
  SELECT caixa_id, 'Clássico', 'classico', jsonb_strip_nulls(jsonb_build_object(
    'nome', nullif(btrim(a->>'nome'), ''),
    'cargo', nullif(btrim(a->>'cargo'), ''),
    'telefone', nullif(btrim(a->>'telefone'), ''),
    'site', nullif(btrim(a->>'site'), ''),
    'registro', nullif(btrim(a->>'extra'), ''),
    'logo', CASE WHEN a->'incluirLogo' = 'true'::jsonb
                 THEN 'caixa' ELSE 'nenhum' END,
    'aviso', '',
    'divisor', 'nenhum'
  ))
  FROM antigas
  RETURNING id, caixa_id
)
UPDATE correio.caixas c
SET assinatura_nova_id = n.id, assinatura_resposta_id = n.id
FROM novas n
WHERE c.id = n.caixa_id;
