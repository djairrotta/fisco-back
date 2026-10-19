-- IPs de onde o administrador usou o Vigia (sessão válida). Protegidos contra
-- bloqueio por 7 dias após o último uso; NÃO entram na lista geo.
CREATE TABLE IF NOT EXISTS vigia.ips_admin (
  ip inet PRIMARY KEY,
  visto_em timestamptz NOT NULL
);
