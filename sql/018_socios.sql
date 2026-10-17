-- =====================================================================
-- Quadro societário, e o cruzamento com a dívida de pessoa física.
--
-- A DESCOBERTA QUE TORNA ISSO POSSÍVEL: PGFN e Receita mascaram o CPF
-- nas MESMAS posições. Ocultam os 3 primeiros dígitos e os 2
-- verificadores, publicando os 6 do meio.
--
--   PGFN (dívida de PF):  XXX878.325XX  ->  878325
--   RFB  (sócio do CNPJ): ***059052**   ->  059052
--
-- Nenhuma das duas revela o CPF. Mas como o recorte é idêntico, o
-- fragmento é comparável, e fragmento + nome liga a dívida PESSOAL de
-- alguém às empresas de que ele é sócio. Para o tributarista isso vale
-- mais que o CPF em si: sócio com dívida federal própria é sinal de
-- prospecção e de risco de redirecionamento de execução.
--
-- É CASAMENTO PROBABILÍSTICO, NÃO IDENTIDADE. 6 dígitos é 1 em um
-- milhão, e o nome reduz muito a colisão, mas não a zera. Por isso o
-- resultado carrega `confianca` e a contagem de candidatos, e em lugar
-- nenhum isto é tratado como "é a mesma pessoa, ponto".
-- =====================================================================
SET search_path TO fisco, public;

-- Chave de nome: sem acento, sem pontuação, caixa alta, espaço simples.
-- "José da Silva-Júnior" e "JOSE DA SILVA JUNIOR" têm que casar.
-- translate() em vez de unaccent(): unaccent e EXTENSAO, mora num schema,
-- e uma funcao SQL sem SET search_path resolve nomes pelo caminho de QUEM
-- CHAMA. Chamada de fora do schema, ela nao acha o unaccent -- foi assim
-- que esta migracao falhou em producao com "function unaccent(text) does
-- not exist", e como ela aborta a execucao inteira, nenhuma migracao
-- posterior conseguia corrigir. translate() e interna, nao depende de
-- extensao nem de search_path, e cobre o portugues.
CREATE OR REPLACE FUNCTION nome_chave(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(
    trim(regexp_replace(
      translate(upper(coalesce(p, '')),
                'ÁÀÂÃÄÅÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑÝ',
                'AAAAAAEEEEIIIIOOOOOUUUUCNY'),
      '[^A-Z0-9]+', ' ', 'g')), '')
$$;

-- Fragmento de CPF: os 6 dígitos que sobrevivem à máscara, em qualquer
-- um dos dois formatos. '000000' é sentinela de campo vazio da Receita.
CREATE OR REPLACE FUNCTION fragmento_cpf(p text) RETURNS char(6)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN d = '000000' THEN NULL
    WHEN length(d) = 6 THEN d::char(6)
    WHEN length(d) = 11 THEN substr(d, 4, 6)::char(6)   -- CPF completo, se um dia vier
    ELSE NULL
  END
  FROM (SELECT regexp_replace(coalesce(p,''), '[^0-9]', '', 'g') AS d) x
$$;

CREATE TABLE IF NOT EXISTS socio (
  cnpj_raiz      char(8) NOT NULL,
  tipo           char(2) NOT NULL,          -- PJ | PF | EX (estrangeiro)
  nome           text    NOT NULL,
  documento      text,                      -- como publicado (mascarado p/ PF)
  fragmento      char(6),                   -- 6 dígitos do CPF, p/ cruzamento
  qualificacao   text,
  entrada        date,
  faixa_etaria   smallint,
  atualizado_em  date    NOT NULL
);

-- PRIMARY KEY nao aceita expressao em Postgres, e `documento` pode ser
-- nulo (socio PJ sem CPF). Indice unico COM expressao resolve os dois:
-- a chave natural e raiz + nome + documento, tratando nulo como vazio.
CREATE UNIQUE INDEX IF NOT EXISTS ux_socio
  ON socio (cnpj_raiz, nome, coalesce(documento, ''));

CREATE INDEX IF NOT EXISTS ix_socio_fragmento ON socio (fragmento)
  WHERE tipo = 'PF' AND fragmento IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_socio_nome ON socio (nome_chave(nome));
CREATE INDEX IF NOT EXISTS ix_socio_raiz ON socio (cnpj_raiz);

-- --- O cruzamento -----------------------------------------------------
-- Liga cada pessoa física devedora às empresas em que ela é sócia.
-- `candidatos` é a honestidade da coisa: quantos sócios distintos batem
-- com o mesmo fragmento+nome. 1 é o caso limpo; mais que 1 significa que
-- o casamento NÃO é único e o advogado precisa conferir.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_socio_devedor AS
WITH pessoa AS (
  SELECT documento, nome, uf, valor_total, qtd_inscricoes, tem_ajuizada,
         fragmento_cpf(documento) AS frag,
         nome_chave(nome)         AS chave
    FROM mv_divida_pessoa
   WHERE fragmento_cpf(documento) IS NOT NULL
     AND nome_chave(nome) IS NOT NULL
),
casado AS (
  SELECT p.documento, p.nome, p.uf, p.valor_total, p.qtd_inscricoes,
         p.tem_ajuizada, s.cnpj_raiz, s.qualificacao, s.entrada,
         count(*) OVER (PARTITION BY p.documento, p.chave) AS candidatos
    FROM pessoa p
    JOIN socio s
      ON s.tipo = 'PF'
     AND s.fragmento = p.frag
     AND nome_chave(s.nome) = p.chave
)
SELECT *,
       CASE WHEN candidatos = 1 THEN 'alta' ELSE 'conferir' END AS confianca
  FROM casado;

-- REFRESH CONCURRENTLY exige indice UNICO sem WHERE. Sem ele a
-- atualizacao concorrente falha e a view fica parada -- o mesmo defeito
-- que a mv_municipio_tributo tinha. A chave natural do cruzamento e
-- a pessoa (documento+nome+uf) mais a empresa (raiz).
CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_soc_dev
  ON mv_socio_devedor (documento, nome, uf, cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_mv_soc_dev_raiz ON mv_socio_devedor (cnpj_raiz);
CREATE INDEX IF NOT EXISTS ix_mv_soc_dev_doc  ON mv_socio_devedor (documento);
