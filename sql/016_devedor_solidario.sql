-- =====================================================================
-- TIPO_DEVEDOR tem TRÊS valores, não dois.
--
-- Conferido contando o arquivo inteiro do Não Previdenciário
-- (45.553.971 linhas, 2º tri/2026):
--    PRINCIPAL       27.221.486
--    CORRESPONSAVEL   1.075.007
--    SOLIDARIO           15.560
--
-- O ETL mapeava /principal/ -> 1 e TODO O RESTO -> 2, então o devedor
-- SOLIDÁRIO virava corresponsável. Para a regra de soma dá no mesmo (nem
-- um nem outro é o principal, e somá-los dobraria o valor da inscrição),
-- mas são situações jurídicas diferentes: a defesa de quem responde
-- solidariamente não é a mesma de quem é corresponsável. Achatar os dois
-- apaga essa distinção justamente para o advogado, que é quem precisa
-- dela.
--
-- 3 = solidário. A regra de ouro continua sendo `tipo_devedor = 1`.
-- =====================================================================
SET search_path TO fisco, public;

COMMENT ON COLUMN divida_inscricao.tipo_devedor IS
  '1 = principal (único que entra em soma), 2 = corresponsável, 3 = solidário';
