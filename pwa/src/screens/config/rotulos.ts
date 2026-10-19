export const ROTULO_TIPO: Record<string, string> = {
  bloqueio_auto: "Bloqueio automático",
  sugestao: "Sugestão de bloqueio",
  anomalia: "Anomalia detectada",
  estrangeiro_agregado: "Ataque estrangeiro agregado",
  modelo_degradado: "Modelo de IA degradado",
  coletor_parado: "Coletor parado",
  bloqueio_expirado: "Bloqueio expirado",
  desfeito: "Bloqueio desfeito",
  email_recebido: "E-mail recebido",
  email_enviado: "E-mail enviado",
  auditoria_achado: "Auditoria: achado novo",
  app_status: "App caiu ou voltou (EasyPanel)",
  app_reinicios: "App reiniciando demais",
  easypanel_falha: "EasyPanel sem resposta",
  servidor: "Servidor: temperatura, memória, carga ou disco",
};
export const ROTULO_PAPEL: Record<string, string> = {
  jev: "Jev (triagem)", segunda: "Segunda opinião", terceira: "Terceira opinião", investigacao: "Investigação",
};
export const PAPEIS = ["jev", "segunda", "terceira", "investigacao"];
