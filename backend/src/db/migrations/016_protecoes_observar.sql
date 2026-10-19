-- Vigia 2.0 (1.4): o modo padrão das proteções na borda passa a ser "observar".
-- Só troca se ainda estiver no padrão antigo ("bloquear") e ninguém tiver
-- escolhido o modo (nenhum protecoes_config com "modo" na auditoria).
UPDATE vigia.config_geral SET valor = to_jsonb('observar'::text)
WHERE chave = 'protecoes_modo'
  AND valor = to_jsonb('bloquear'::text)
  AND NOT EXISTS (
    SELECT 1 FROM vigia.auditoria
    WHERE acao = 'protecoes_config' AND detalhes -> 'mudancas' ? 'modo');
