-- WhatsApp espelha apenas os eventos críticos (evita spam). Push segue ligado para todos.
UPDATE vigia.config_notificacao
   SET whatsapp = (tipo IN ('bloqueio_auto', 'modelo_degradado', 'coletor_parado'));
ALTER TABLE vigia.config_notificacao ALTER COLUMN whatsapp SET DEFAULT false;
