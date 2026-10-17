-- =====================================================================
-- 021: confianca do vinculo socio x devedor pessoa fisica, recalculada.
--
-- A 018 media "candidatos" com count(*) OVER (PARTITION BY pessoa): isso
-- conta EMPRESAS, nao pessoas. Quem e socio de duas empresas virava
-- "2 candidatos, conferir", e quase todo vinculo verdadeiro aparecia como
-- duvidoso (visto com dado real: a maioria das linhas marcada "conferir").
--
-- O casamento ja exige o nome completo identico E os 6 digitos do meio do
-- CPF. Dois homonimos com os mesmos 6 digitos e chance da ordem de 1 em
-- 1 milhao por par; o risco real e o NOME CURTO ("JOSE SILVA"), que tem
-- milhares de homonimos. Entao:
--   alta      nome com 3 ou mais palavras
--   conferir  nome com 2 palavras ou menos
-- `empresas` passa a dizer o que o numero antigo dizia sem querer: em
-- quantas empresas devedoras a pessoa aparece.
--
-- Idempotente: so recria se a coluna nova nao existir. Recriar a cada boot
-- apagaria a view e obrigaria a recalcular tudo em todo deploy.
-- =====================================================================
SET search_path TO fisco, public;

DO $$
BEGIN
  IF to_regclass('fisco.mv_socio_devedor') IS NOT NULL AND EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = 'fisco.mv_socio_devedor'::regclass AND attname = 'palavras_nome') THEN
    RETURN;
  END IF;

  DROP MATERIALIZED VIEW IF EXISTS fisco.mv_socio_devedor;

  EXECUTE $v$
    CREATE MATERIALIZED VIEW fisco.mv_socio_devedor AS
    WITH pessoa AS (
      SELECT documento, nome, uf, valor_total, qtd_inscricoes, tem_ajuizada,
             fisco.fragmento_cpf(documento) AS frag,
             fisco.nome_chave(nome)         AS chave
        FROM fisco.mv_divida_pessoa
       WHERE fisco.fragmento_cpf(documento) IS NOT NULL
         AND fisco.nome_chave(nome) IS NOT NULL
    ),
    casado AS (
      SELECT p.documento, p.nome, p.uf, p.valor_total, p.qtd_inscricoes,
             p.tem_ajuizada, s.cnpj_raiz, s.qualificacao, s.entrada,
             cardinality(string_to_array(p.chave, ' ')) AS palavras_nome,
             count(*) OVER (PARTITION BY p.documento, p.chave, p.uf) AS empresas
        FROM pessoa p
        JOIN fisco.socio s
          ON s.tipo = 'PF'
         AND s.fragmento = p.frag
         AND fisco.nome_chave(s.nome) = p.chave
    )
    SELECT *,
           -- mantida por compatibilidade com quem le a coluna antiga
           1::bigint AS candidatos,
           CASE WHEN palavras_nome >= 3 THEN 'alta' ELSE 'conferir' END AS confianca
      FROM casado
    WITH NO DATA
  $v$;

  CREATE UNIQUE INDEX ux_mv_soc_dev ON fisco.mv_socio_devedor (documento, nome, uf, cnpj_raiz);
  CREATE INDEX ix_mv_soc_dev_raiz ON fisco.mv_socio_devedor (cnpj_raiz);
  CREATE INDEX ix_mv_soc_dev_doc  ON fisco.mv_socio_devedor (documento);
END $$;
