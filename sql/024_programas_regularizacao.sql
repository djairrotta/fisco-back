-- =====================================================================
-- 024: programas de regularizacao (transacao e parcelamento) da PGFN, da
-- PGE-SP e da AGE-MG, como DADO, com fonte e data de verificacao.
--
-- Por que tabela e nao texto na tela: o painel usa as regras para dizer,
-- empresa por empresa, quais programas cabem (valor, porte, data de
-- inscricao, tipo de debito) e para filtrar a pesquisa. Edital muda
-- (prazo prorrogado, corte de data novo): atualizar e um UPSERT aqui, na
-- proxima migracao, sem mexer em codigo.
--
-- Verificado em 17/10/2026 contra as fontes citadas em `fonte_url`. O
-- texto oficial do edital prevalece; o painel diz isso ao lado de cada um.
-- =====================================================================
SET search_path TO fisco, public;

CREATE TABLE IF NOT EXISTS programa_regularizacao (
  slug            text PRIMARY KEY,
  orgao           text NOT NULL,            -- PGFN | PGE_SP | AGE_MG
  nome            text NOT NULL,
  tipo            text NOT NULL,            -- transacao_adesao | transacao_individual | parcelamento
  base_legal      text NOT NULL,
  publico         text NOT NULL,
  debitos         text NOT NULL,
  desconto        text NOT NULL,
  entrada         text,
  parcelas        text NOT NULL,
  observacoes     text,
  adesao_inicio   timestamptz,
  adesao_fim      timestamptz,              -- NULL = permanente
  onde_aderir     text,
  fonte_url       text,
  verificado_em   date NOT NULL,
  -- regras para a elegibilidade automatica (todas opcionais):
  --   origens: ["PGFN_GERAL","PGFN_PREV","PGFN_FGTS","ESTADUAL_SP","ESTADUAL_MG"]
  --   valor_max, inscritos_ate, portes ([1,3] = ME/EPP), mei, perfil ("dificil_recuperacao")
  --   desconto_teto (fracao do valor total), so_individual_acima
  regras          jsonb NOT NULL DEFAULT '{}',
  ordem           int NOT NULL DEFAULT 100,
  ativo           boolean NOT NULL DEFAULT true
);

INSERT INTO programa_regularizacao
  (slug, orgao, nome, tipo, base_legal, publico, debitos, desconto, entrada, parcelas, observacoes,
   adesao_inicio, adesao_fim, onde_aderir, fonte_url, verificado_em, regras, ordem)
VALUES
-- ---------------------------------------------------------------- PGFN
('pgfn-6-2026-capacidade', 'PGFN', 'Transação por capacidade de pagamento (Edital PGDAU 6/2026)',
 'transacao_adesao',
 'Lei 13.988/2020, art. 11; Portaria PGFN 6.757/2022; Edital PGDAU 6/2026, reaberto pelo Edital PGDAU 10/2026',
 'Pessoas físicas e jurídicas com débitos de até R$ 45 milhões inscritos em dívida ativa da União até 03/07/2026',
 'Tributários e não tributários inscritos na dívida ativa da União (não inclui FGTS, que tem edital próprio)',
 'Até 100% de juros, multa e encargo legal, limitado a 65% do total (70% para pessoa física, ME, EPP e empresa em recuperação judicial). Depende da classe de capacidade de pagamento (CAPAG): classes A e B sem desconto, C e D com desconto.',
 '6% do total em até 6 meses (perfis diferenciados: em até 12)',
 'Saldo em até 114 parcelas (perfis diferenciados: até 133). Contribuições previdenciárias sobre a folha: no máximo 60 parcelas (CF art. 195, § 11).',
 'Não admite prejuízo fiscal nem base negativa de CSLL. Admite precatórios federais.',
 '2026-10-01 08:00-03', '2027-01-29 19:00-03', 'https://www.regularize.pgfn.gov.br',
 'https://www.barbieriadvogados.com/edital-pgfn-6-2026-transacao-tributaria/', '2026-10-17',
 '{"origens":["PGFN_GERAL","PGFN_PREV"],"valor_max":45000000,"inscritos_ate":"2026-07-03","desconto_teto":0.65,"desconto_teto_diferenciado":0.70}', 10),

('pgfn-6-2026-dificil', 'PGFN', 'Débitos de difícil recuperação ou irrecuperáveis (Edital PGDAU 6/2026)',
 'transacao_adesao',
 'Lei 13.988/2020, art. 11; Edital PGDAU 6/2026, reaberto pelo Edital PGDAU 10/2026',
 'Devedor com inscrição há mais de 15 anos sem garantia ou suspensão; suspensão judicial há mais de 10 anos; falência, liquidação ou intervenção; CNPJ baixado, inapto ou suspenso; pessoa física com indicativo de óbito',
 'Tributários e não tributários inscritos até 03/07/2026, até R$ 45 milhões',
 '65% do total (70% para pessoa física, ME, EPP e perfis diferenciados)',
 '5% em até 12 meses',
 'Saldo em até 108 parcelas (perfis diferenciados: até 133); previdenciário sobre a folha limitado a 60',
 'Não depende da classificação CAPAG: a situação objetiva basta.',
 '2026-10-01 08:00-03', '2027-01-29 19:00-03', 'https://www.regularize.pgfn.gov.br',
 'https://www.barbieriadvogados.com/edital-pgfn-6-2026-transacao-tributaria/', '2026-10-17',
 '{"origens":["PGFN_GERAL","PGFN_PREV"],"valor_max":45000000,"inscritos_ate":"2026-07-03","perfil":"dificil_recuperacao","desconto_teto":0.65,"desconto_teto_diferenciado":0.70}', 20),

('pgfn-6-2026-pequeno-valor', 'PGFN', 'Pequeno valor (Edital PGDAU 6/2026)',
 'transacao_adesao',
 'Lei 13.988/2020, art. 25; Edital PGDAU 6/2026, reaberto pelo Edital PGDAU 10/2026',
 'Pessoa física, MEI, ME e EPP com inscrições de até 60 salários mínimos (R$ 97.260,00 em 2026), inscritas até 01/10/2025',
 'Débitos inscritos na dívida ativa da União de até 60 salários mínimos por inscrição',
 '50% à vista sobre o total, inclusive principal; no parcelado, de 50% a 30% conforme o prazo',
 '5% em até 5 meses',
 'Saldo de 7 a 55 meses',
 'Não depende da capacidade de pagamento. Há divergência na página da PGFN sobre o fim do prazo (29/01/2027 x 29/07/2027): conferir.',
 '2026-10-01 08:00-03', '2027-01-29 19:00-03', 'https://www.regularize.pgfn.gov.br',
 'https://www.barbieriadvogados.com/edital-pgfn-6-2026-transacao-tributaria/', '2026-10-17',
 '{"origens":["PGFN_GERAL","PGFN_PREV"],"valor_max_inscricao":97260,"inscritos_ate":"2025-10-01","portes":[1,3],"mei":true,"desconto_teto":0.50}', 30),

('pgfn-12-2026-fgts', 'PGFN', 'FGTS em dívida ativa (Edital PGDAU 12/2026)',
 'transacao_adesao',
 'Edital PGDAU 12/2026; Lei Complementar 110/2001',
 'Empregadores, pessoa física ou jurídica, com passivo de FGTS de até R$ 45 milhões',
 'FGTS e contribuições da LC 110/2001 inscritos em dívida ativa',
 'Até 100% dos juros não destinados ao trabalhador, multas e encargos, limitado a 65% da dívida. A parte do trabalhador não tem desconto.',
 'FGTS rescisório em até 12 parcelas',
 'Saldo em até 108 ou 133 parcelas, conforme o perfil',
 'Permite migrar acordo ativo feito com a Caixa. Exclui empregador do cadastro de trabalho análogo à escravidão.',
 '2026-10-15 00:00-03', '2027-01-29 19:00-03', 'https://www.regularize.pgfn.gov.br',
 'https://www.contabeis.com.br/noticias/79859/novos-editais-da-pgfn-para-renegociacao-de-dividas/', '2026-10-17',
 '{"origens":["PGFN_FGTS"],"valor_max":45000000,"desconto_teto":0.65}', 40),

('pgfn-9-2026-mei', 'PGFN', 'Desenrola MEI (Edital PGDAU 9/2026)',
 'transacao_adesao',
 'Edital PGDAU 9/2026',
 'Microempreendedor individual com débitos de até R$ 20 mil inscritos na dívida ativa da União',
 'Débitos do MEI inscritos na dívida ativa da União',
 'Até 70% de juros, multas e encargos, nos limites do edital',
 NULL, 'Conforme o edital',
 NULL,
 NULL, '2027-01-29 19:00-03', 'https://www.regularize.pgfn.gov.br',
 'https://www.contabeis.com.br/noticias/79859/novos-editais-da-pgfn-para-renegociacao-de-dividas/', '2026-10-17',
 '{"origens":["PGFN_GERAL","PGFN_PREV"],"valor_max":20000,"mei":true,"so_mei":true,"desconto_teto":0.70}', 50),

('pgfn-mei-pequeno-valor', 'PGFN', 'Desenrola MEI Pequeno Valor (Portaria PGFN 2.970/2026)',
 'transacao_adesao',
 'Portaria PGFN 2.970, de 29/09/2026; Lei 13.988/2020, art. 25',
 'MEI com débitos de até 5 salários mínimos (R$ 8.105) no código de receita 1537 (Simples Nacional)',
 'Débitos do MEI de pequeno valor, código 1537',
 '50%',
 NULL, 'Até 60 parcelas',
 NULL,
 '2026-10-01 00:00-03', '2027-01-29 23:59-03', 'https://www.regularize.pgfn.gov.br',
 'https://www.contabeis.com.br/noticias/79859/novos-editais-da-pgfn-para-renegociacao-de-dividas/', '2026-10-17',
 '{"origens":["PGFN_GERAL"],"valor_max":8105,"mei":true,"so_mei":true,"desconto_teto":0.50}', 55),

('pgfn-individual', 'PGFN', 'Transação individual (acima de R$ 1 milhão)',
 'transacao_individual',
 'Lei 13.988/2020; Portaria PGFN 6.757/2022',
 'Débitos acima de R$ 1 milhão. De R$ 1 milhão a R$ 10 milhões: transação individual simplificada. Acima de R$ 10 milhões: transação individual.',
 'Débitos inscritos na dívida ativa da União',
 'Até 65% do total (70% para pessoa física, ME, EPP); condições negociadas caso a caso',
 'Negociada', 'Até 120 parcelas (145 para pessoa física, ME, EPP); previdenciário sobre a folha limitado a 60',
 'Admite, em caráter excepcional, uso de prejuízo fiscal e base negativa de CSLL (art. 11, IV).',
 NULL, NULL, 'https://www.regularize.pgfn.gov.br',
 'https://www.barbieriadvogados.com/edital-pgfn-6-2026-transacao-tributaria/', '2026-10-17',
 '{"origens":["PGFN_GERAL","PGFN_PREV"],"valor_min":1000000,"desconto_teto":0.65,"desconto_teto_diferenciado":0.70}', 60),

('pgfn-parcelamento-ordinario', 'PGFN', 'Parcelamento ordinário da dívida ativa da União',
 'parcelamento',
 'Lei 10.522/2002, arts. 10 a 14-F',
 'Qualquer devedor, a qualquer tempo',
 'Débitos inscritos na dívida ativa da União',
 'Sem desconto',
 'Primeira parcela no pedido', 'Até 60 parcelas mensais, corrigidas pela Selic',
 'Alternativa permanente quando não há edital que caiba ou a CAPAG não dá desconto.',
 NULL, NULL, 'https://www.regularize.pgfn.gov.br',
 'https://www.planalto.gov.br/ccivil_03/leis/2002/l10522.htm', '2026-10-17',
 '{"origens":["PGFN_GERAL","PGFN_PREV"]}', 90),

-- ---------------------------------------------------------------- PGE-SP
('sp-acordo-paulista-1-2025', 'PGE_SP', 'Acordo Paulista (Edital PGE/Transação 1/2025)',
 'transacao_adesao',
 'Lei Estadual SP 17.843/2023; Resoluções PGE 6/2024 e 53/2025; Edital PGE/Transação 1/2025',
 'Devedores de ICMS, IPVA, ITCMD e multas do Procon inscritos em dívida ativa do Estado',
 'ICMS, IPVA, ITCMD e multas do Procon inscritos em dívida ativa',
 'Irrecuperáveis: até 75% de juros e multas; difícil recuperação: até 60%; recuperáveis: sem desconto. Teto de 65% do total, principal preservado.',
 'Sem entrada',
 'Até 120 parcelas pela Selic; recuperáveis acima de 84 parcelas exigem garantia',
 'ENCERRADO em 27/02/2026. Não localizamos edital de adesão aberto em SP na verificação de 17/10/2026: conferir o portal. Admite créditos de ICMS e precatórios para até 75% do saldo.',
 '2025-09-08 00:00-03', '2026-02-27 23:59-03', 'https://www.dividaativa.pge.sp.gov.br/transacao',
 'https://www.moorebrasil.com.br/blog/acordo-paulista-novo-edital-de-transacao-tributaria/', '2026-10-17',
 '{"origens":["ESTADUAL_SP"],"desconto_teto":0.65}', 110),

('sp-transacao-individual', 'PGE_SP', 'Transação individual da PGE-SP',
 'transacao_individual',
 'Lei Estadual SP 17.843/2023',
 'Devedores com débitos inscritos em dívida ativa do Estado, por proposta individual',
 'Débitos inscritos em dívida ativa do Estado de SP',
 'Conforme a classificação de recuperabilidade (Resolução PGE 6/2024); teto de 65% do total',
 'Negociada', 'Negociadas caso a caso',
 'Caminho permanente fora das janelas de edital.',
 NULL, NULL, 'https://www.dividaativa.pge.sp.gov.br/transacao',
 'https://www.dividaativa.pge.sp.gov.br/transacao/resources/pdf/Cartilha_Transacao_-_V.3._Atualizada_em_10.06.2024__1___1.pdf', '2026-10-17',
 '{"origens":["ESTADUAL_SP"],"desconto_teto":0.65}', 120),

-- ---------------------------------------------------------------- AGE-MG
('mg-transacao-25144', 'AGE_MG', 'Transação tributária de Minas Gerais (Lei 25.144/2025)',
 'transacao_adesao',
 'Lei Estadual MG 25.144/2025; Resolução Conjunta AGE/SEF 5.942/2025',
 'Devedores com débitos inscritos em dívida ativa do Estado. Transação individual para ICMS acima de 1,5 milhão de Ufemg; simplificada de ICMS para créditos irrecuperáveis ou de difícil recuperação; pequeno valor para créditos abaixo da alçada de execução e inscritos há mais de 2 anos.',
 'Créditos inscritos em dívida ativa de MG (exclui devedor contumaz, débitos declarados no Simples Nacional, adicional do FEM e transação rescindida nos últimos 2 anos)',
 'Sobre juros e multas, principal preservado. Irrecuperável: 80% (até 6x), 70% (até 24x), 60% (até 60x), 50% (acima de 60x). Difícil recuperação: 70%, 60%, 50%, 40%. Teto de 65% do total (70% para pessoa física, ME, EPP, liquidação ou falência).',
 'Igual às demais parcelas, no mês da celebração',
 'Até 120 parcelas (145 para pessoa física, ME, EPP, liquidação ou falência); parcela mínima de R$ 2.000; Selic',
 'As janelas de adesão saem em editais conjuntos AGE/SEF; a simplificada de ICMS é pelo Siare. Datas do edital vigente: conferir no site da AGE.',
 NULL, NULL, 'https://advocaciageral.mg.gov.br',
 'https://www.legisweb.com.br/legislacao/?id=483658', '2026-10-17',
 '{"origens":["ESTADUAL_MG"],"desconto_teto":0.65,"desconto_teto_diferenciado":0.70}', 210)
ON CONFLICT (slug) DO UPDATE SET
  orgao = EXCLUDED.orgao, nome = EXCLUDED.nome, tipo = EXCLUDED.tipo, base_legal = EXCLUDED.base_legal,
  publico = EXCLUDED.publico, debitos = EXCLUDED.debitos, desconto = EXCLUDED.desconto,
  entrada = EXCLUDED.entrada, parcelas = EXCLUDED.parcelas, observacoes = EXCLUDED.observacoes,
  adesao_inicio = EXCLUDED.adesao_inicio, adesao_fim = EXCLUDED.adesao_fim,
  onde_aderir = EXCLUDED.onde_aderir, fonte_url = EXCLUDED.fonte_url,
  verificado_em = EXCLUDED.verificado_em, regras = EXCLUDED.regras, ordem = EXCLUDED.ordem;
