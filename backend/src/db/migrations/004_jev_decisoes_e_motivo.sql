-- Classificador: Jev 1.13 pela Decisions API do OpenRouter (decisão tipada).
-- Só troca quem ainda está no padrão antigo; escolha do usuário fica.
ALTER TABLE correio.config_ia ALTER COLUMN modelo SET DEFAULT 'typesafe/jev-1.13';
UPDATE correio.config_ia SET modelo = 'typesafe/jev-1.13'
  WHERE papel = 'classificador' AND modelo = 'typesafe/jev-router';

-- Motivo legível (pt-BR) do estado da caixa, ex.: a chave mestra mudou e a
-- senha guardada não decifra mais → precisa_senha com "senha precisa ser
-- digitada de novo". NULL = sem observação.
ALTER TABLE correio.caixas ADD COLUMN estado_motivo text;
