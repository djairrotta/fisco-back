// Procedimentos da API do EasyPanel, escritos como "roteador/procedimento".
// Mudam entre versões: cada grupo lista os candidatos em ordem; o cliente usa
// o primeiro que responder e lembra qual funcionou (aparece em Apps). Para
// ajustar a uma versão nova do painel, basta mexer aqui.
//
// Transportes (TRANSPORTES, na ordem de tentativa):
// - orpc: POST /api/rpc/<roteador>/<proc>, corpo {"json": entrada} (versões
//   atuais; é o que a interface do painel usa);
// - trpc: GET /api/trpc/<roteador>.<proc>?input={"json": entrada} (versões
//   antigas). O nome vira "a.b.c" trocando "/" por ".".

export const TRANSPORTES = ["orpc", "trpc"] as const;
export type Transporte = typeof TRANSPORTES[number];

export const PROCEDIMENTOS = {
  /** Usuário dono do token: valida EASYPANEL_TOKEN na partida. */
  usuario: ["auth/getUser"],
  /** Projetos + serviços (tipo, domínios, env, réplicas) numa chamada só. */
  listar: ["projects/listProjectsAndServices"],
  /** Alternativa: lista os projetos e inspeciona um por um. */
  listarProjetos: ["projects/listProjects"],
  /** Entrada: { projectName }. */
  inspecionarProjeto: ["projects/inspectProject"],
  /** Estatísticas (CPU/mem/estado) de todos os contêineres, sem entrada. */
  metricasTodas: ["monitor/getMonitorTableData", "monitor/getDockerTaskStats"],
  /** Estatísticas de um serviço. Entrada: { projectName, serviceName }. */
  metricasServico: [
    "monitor/getServiceStats",
    "services/common/getServiceStats",
  ],
} as const;

/**
 * Inspeção de um serviço (env, domínios, réplicas), por tipo. Entrada:
 * { projectName, serviceName }. "{tipo}" vira app, compose, postgres…
 */
export const INSPECIONAR_SERVICO = ["services/{tipo}/inspectService"] as const;
/** Candidatos extras só para serviços do tipo app. */
export const INSPECIONAR_APP = ["apps/inspectService"] as const;

/** Tipos de serviço cujo env é analisado (os bancos guardam a senha à parte). */
export const TIPOS_COM_ENV = new Set(["app", "compose"]);

export type GrupoProcedimento =
  | keyof typeof PROCEDIMENTOS
  | `inspecionar:${string}`;
