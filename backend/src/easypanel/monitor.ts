// Monitor dos apps do EasyPanel (a cada 2 min): snapshot em vigia.apps,
// viradas de status (push de queda/volta e de reinícios), falhas seguidas da
// API, higiene do env (achados "env" na auditoria, só nomes) e domínios como
// sugestões de host da auditoria. O env só existe em memória durante a análise.
import type { Sql } from "../db/client.ts";
import type { Notificacao, TipoEvento } from "../notify/notifier.ts";
import {
  type AchadoNovo,
  persistirResultados,
  pushAgregado,
  relevante,
  sugerirHosts,
} from "../auditoria/execucao.ts";
import type { ResultadoHost } from "../auditoria/verificacoes.ts";
import {
  type ClienteEasypanel,
  ErroEasypanel,
  type Metricas,
  type ServicoEp,
  type SituacaoToken,
  type StatusApp,
} from "./cliente.ts";
import { analisarEnv, ehProducao, type EnvApp, lerEnv } from "./env.ts";
import { TIPOS_COM_ENV } from "./procedimentos.ts";

export const INTERVALO_MONITOR_MS = 2 * 60_000;
const FALHAS_PARA_ALERTA = 5;
const JANELA_REINICIOS_MS = 30 * 60_000;
const REINICIOS_PARA_ALERTA = 3;
const CHAVE_ESTADO = "easypanel_estado";

export interface EstadoEasypanel {
  ultimoOk: string | null;
  ultimaTentativa: string;
  falhasSeguidas: number;
  /** Mensagem nossa (classe/status HTTP), nunca corpo de resposta. */
  ultimoErro: string | null;
  /** Grupo → procedimento que funcionou (null: nenhum respondeu). */
  procedimentos: Record<string, string | null>;
  /** Transporte que respondeu (orpc ou trpc). */
  transporte?: string | null;
  /** Resultado da validação do token (auth/getUser ou 401 da API). */
  autenticacao?: SituacaoToken | null;
}

export interface App {
  chave: string;
  projeto: string;
  servico: string;
  tipo: string;
  status: StatusApp;
  replicas: number | null;
  cpu: number | null;
  memBytes: number | null;
  memPct: number | null;
  dominios: string[];
  ultimaMudanca: string | null;
  reinicios: number;
  vistoEm: string | null;
}

export interface MonitorDeps {
  sql: Sql;
  agora: () => Date;
  cliente: ClienteEasypanel;
  notificar(tipo: TipoEvento, n: Notificacao): Promise<unknown>;
}

export interface ResumoMonitor {
  ok: boolean;
  apps: number;
  erro?: string;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
const mensagemErro = (e: unknown) =>
  e instanceof ErroEasypanel ? e.message : "Falha ao consultar o EasyPanel";

function linhaApp(r: Record<string, unknown>): App {
  return {
    chave: `${r.projeto}/${r.servico}`,
    projeto: String(r.projeto),
    servico: String(r.servico),
    tipo: String(r.tipo),
    status: r.status as StatusApp,
    replicas: num(r.replicas),
    cpu: num(r.cpu),
    memBytes: num(r.mem_bytes),
    memPct: num(r.mem_pct),
    dominios: (r.dominios as string[] | null) ?? [],
    ultimaMudanca: iso(r.ultima_mudanca),
    reinicios: Number(r.reinicios ?? 0),
    vistoEm: iso(r.visto_em),
  };
}

export async function listarApps(sql: Sql): Promise<App[]> {
  const rows = await sql`SELECT * FROM vigia.apps ORDER BY projeto, servico`;
  return rows.map(linhaApp);
}

export async function verApp(
  sql: Sql,
  projeto: string,
  servico: string,
): Promise<App | null> {
  const [r] = await sql`SELECT * FROM vigia.apps
    WHERE projeto = ${projeto} AND servico = ${servico}`;
  return r ? linhaApp(r) : null;
}

export async function estadoEasypanel(
  sql: Sql,
): Promise<EstadoEasypanel | null> {
  const [r] = await sql`SELECT valor FROM vigia.config_geral
    WHERE chave = ${CHAVE_ESTADO}`;
  return (r?.valor as EstadoEasypanel | undefined) ?? null;
}

async function gravarEstado(sql: Sql, e: EstadoEasypanel) {
  await sql`INSERT INTO vigia.config_geral (chave, valor)
    VALUES (${CHAVE_ESTADO}, ${sql.json(e as never)})
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
}

/** Status a partir do serviço (habilitado/réplicas) e das métricas. */
export function statusDe(s: ServicoEp, m?: Metricas): StatusApp {
  if (s.habilitado === false || s.replicas === 0) return "stopped";
  if (m?.status) return m.status;
  if (m?.replicasRodando !== null && m?.replicasRodando !== undefined) {
    return m.replicasRodando > 0 ? "running" : "error";
  }
  if (m && (m.cpu !== null || m.memBytes !== null)) return "running";
  return "unknown";
}

const rotuloStatus: Record<StatusApp, string> = {
  running: "rodando",
  stopped: "parado",
  error: "com erro",
  unknown: "desconhecido",
};

const avisar = async (
  d: MonitorDeps,
  tipo: TipoEvento,
  n: Notificacao,
) => {
  try {
    await d.notificar(tipo, n);
  } catch (e) {
    console.error(`easypanel: falha no push ${tipo}:`, (e as Error)?.message);
  }
};

export async function monitorarEasypanel(
  d: MonitorDeps,
): Promise<ResumoMonitor> {
  const agora = d.agora();
  const anterior = await estadoEasypanel(d.sql);
  let servicos: ServicoEp[];
  try {
    servicos = await d.cliente.listar();
  } catch (e) {
    const falhas = (anterior?.falhasSeguidas ?? 0) + 1;
    const erro = mensagemErro(e);
    await gravarEstado(d.sql, {
      ultimoOk: anterior?.ultimoOk ?? null,
      ultimaTentativa: agora.toISOString(),
      falhasSeguidas: falhas,
      ultimoErro: erro,
      procedimentos: d.cliente.procedimentos(),
      transporte: d.cliente.transporte(),
      autenticacao: e instanceof ErroEasypanel && e.tipo === "auth"
        ? "token_invalido"
        : (anterior?.autenticacao ?? null),
    });
    console.error(`easypanel: ${erro} (${falhas} seguida(s))`);
    if (falhas === FALHAS_PARA_ALERTA) {
      await avisar(d, "easypanel_falha", {
        titulo: "EasyPanel sem resposta",
        corpo:
          `${falhas} falhas seguidas ao consultar a API do EasyPanel: ${erro}`,
        url: "/apps",
        chaveAgregacao: "easypanel",
      });
    }
    return { ok: false, apps: 0, erro };
  }

  // Detalhes que a listagem não trouxe (env/domínios) e métricas.
  for (const s of servicos) {
    if (s.env !== null || !TIPOS_COM_ENV.has(s.tipo)) continue;
    try {
      const x = await d.cliente.inspecionar(s);
      if (x) Object.assign(s, x);
    } catch (e) {
      console.error(
        `easypanel: inspecionar ${s.projeto}/${s.servico}: ${mensagemErro(e)}`,
      );
    }
  }
  let metricas: Map<string, Metricas> | undefined;
  try {
    metricas = await d.cliente.metricasTodas();
  } catch (e) {
    console.error(`easypanel: métricas: ${mensagemErro(e)}`);
  }
  if (!metricas) {
    metricas = new Map();
    for (const s of servicos) {
      try {
        const m = await d.cliente.metricasServico(s);
        if (m) metricas.set(`${s.projeto}/${s.servico}`, m);
      } catch (e) {
        console.error(
          `easypanel: métricas ${s.projeto}/${s.servico}: ${mensagemErro(e)}`,
        );
      }
    }
  }

  const antes = new Map(
    (await d.sql`SELECT * FROM vigia.apps`).map((r) => [
      `${r.projeto}/${r.servico}`,
      r,
    ]),
  );
  const limiteReinicio = new Date(agora.getTime() - JANELA_REINICIOS_MS);
  for (const s of servicos) {
    const chave = `${s.projeto}/${s.servico}`;
    const m = metricas.get(chave);
    const status = statusDe(s, m);
    const prev = antes.get(chave);
    const statusAntes = prev?.status as StatusApp | undefined;
    let ultimaMudanca: Date | null = prev?.ultima_mudanca
      ? new Date(prev.ultima_mudanca)
      : agora;
    let reinicios = Number(prev?.reinicios ?? 0);
    let recentes = ((prev?.reinicios_recentes as Date[] | null) ?? [])
      .map((x) => new Date(x)).filter((x) => x > limiteReinicio);
    if (prev && statusAntes !== status) {
      ultimaMudanca = agora;
      const caiu = statusAntes === "running" &&
        (status === "stopped" || status === "error");
      const voltou = status === "running" &&
        (statusAntes === "stopped" || statusAntes === "error");
      if (caiu) {
        await avisar(d, "app_status", {
          titulo: `App fora do ar: ${chave}`,
          corpo: `${chave} está ${rotuloStatus[status]} no EasyPanel.`,
          url: "/apps",
          chaveAgregacao: chave,
        });
      }
      if (voltou) {
        reinicios++;
        recentes.push(agora);
        await avisar(d, "app_status", {
          titulo: `App voltou: ${chave}`,
          corpo: `${chave} voltou a rodar (estava ${
            rotuloStatus[statusAntes!]
          }).`,
          url: "/apps",
          chaveAgregacao: chave,
        });
        if (recentes.length > REINICIOS_PARA_ALERTA) {
          await avisar(d, "app_reinicios", {
            titulo: `${chave} reiniciou ${recentes.length} vezes em 30 min`,
            corpo:
              "O app está caindo e voltando: veja os logs no EasyPanel (falta de memória, erro na inicialização, healthcheck).",
            url: "/apps",
            chaveAgregacao: chave,
          });
        }
      }
    }
    recentes = recentes.slice(-20);
    await d.sql`
      INSERT INTO vigia.apps (projeto, servico, tipo, status, replicas, cpu,
        mem_bytes, mem_pct, dominios, ultima_mudanca, reinicios,
        reinicios_recentes, visto_em)
      VALUES (${s.projeto}, ${s.servico}, ${s.tipo}, ${status},
        ${m?.replicasRodando ?? s.replicas}, ${m?.cpu ?? null},
        ${m?.memBytes ?? null}, ${m?.memPct ?? null}, ${s.dominios},
        ${ultimaMudanca}, ${reinicios},
        ${recentes.map((x) => x.toISOString())}::timestamptz[], ${agora})
      ON CONFLICT (projeto, servico) DO UPDATE SET
        tipo = EXCLUDED.tipo, status = EXCLUDED.status,
        replicas = EXCLUDED.replicas, cpu = EXCLUDED.cpu,
        mem_bytes = EXCLUDED.mem_bytes, mem_pct = EXCLUDED.mem_pct,
        dominios = EXCLUDED.dominios, ultima_mudanca = EXCLUDED.ultima_mudanca,
        reinicios = EXCLUDED.reinicios,
        reinicios_recentes = EXCLUDED.reinicios_recentes,
        visto_em = EXCLUDED.visto_em`;
  }
  // Serviços que sumiram do painel.
  const vistos = servicos.map((s) => `${s.projeto}/${s.servico}`);
  await d.sql`DELETE FROM vigia.apps
    WHERE NOT (projeto || '/' || servico = ANY(${vistos}))`;

  await higieneEnv(d, servicos, agora);

  try {
    await sugerirHosts(d.sql, servicos.flatMap((s) => s.dominios), {
      confirmar: true,
      origem: "easypanel",
    });
  } catch (e) {
    console.error(`easypanel: sugerir hosts: ${(e as Error)?.message}`);
  }

  await gravarEstado(d.sql, {
    ultimoOk: agora.toISOString(),
    ultimaTentativa: agora.toISOString(),
    falhasSeguidas: 0,
    ultimoErro: null,
    procedimentos: d.cliente.procedimentos(),
    transporte: d.cliente.transporte(),
    autenticacao: "ok",
  });
  return { ok: true, apps: servicos.length };
}

/**
 * Valida EASYPANEL_TOKEN na partida (auth/getUser) e grava o resultado em
 * easypanel_estado.autenticacao. Nunca lança.
 */
export async function validarTokenEasypanel(
  d: Pick<MonitorDeps, "sql" | "agora" | "cliente">,
): Promise<SituacaoToken | "erro"> {
  let r: SituacaoToken | "erro";
  let erro: string | null = null;
  try {
    r = await d.cliente.verificarToken();
  } catch (e) {
    r = "erro";
    erro = mensagemErro(e);
  }
  const anterior = await estadoEasypanel(d.sql);
  await gravarEstado(d.sql, {
    ultimoOk: anterior?.ultimoOk ?? null,
    ultimaTentativa: d.agora().toISOString(),
    falhasSeguidas: anterior?.falhasSeguidas ?? 0,
    ultimoErro: erro ??
      (r === "token_invalido"
        ? "EasyPanel recusou o token: confira EASYPANEL_TOKEN"
        : anterior?.ultimoErro ?? null),
    procedimentos: d.cliente.procedimentos(),
    transporte: d.cliente.transporte(),
    autenticacao: r === "erro" ? (anterior?.autenticacao ?? null) : r,
  });
  if (r === "token_invalido") {
    console.error("easypanel: token inválido (auth/getUser recusou)");
  } else if (r === "erro") console.error(`easypanel: validar token: ${erro}`);
  else console.log(`easypanel: token ${r === "ok" ? "ok" : "não verificado"}`);
  return r;
}

/** Analisa o env (em memória) e grava só os achados (nomes de variáveis). */
async function higieneEnv(d: MonitorDeps, servicos: ServicoEp[], agora: Date) {
  const apps: EnvApp[] = servicos
    .filter((s) => TIPOS_COM_ENV.has(s.tipo) && s.env !== null)
    .map((s) => ({
      chave: `${s.projeto}/${s.servico}`,
      producao: ehProducao(s),
      env: lerEnv(s.env!),
    }));
  // Os valores não ficam pendurados nos objetos do serviço.
  for (const s of servicos) s.env = null;
  if (!apps.length) return;
  let novos: AchadoNovo[] = [];
  try {
    const r = await analisarEnv(apps);
    const resultados: ResultadoHost[] = [...r.entries()].map(([host, a]) => ({
      host,
      achados: a ? [a] : [],
      avaliadas: ["env"],
    }));
    novos = (await persistirResultados(d.sql, resultados, agora)).novos;
  } catch (e) {
    console.error(`easypanel: higiene do env: ${(e as Error)?.name}`);
    return;
  }
  const avisos = novos.filter((n) => relevante(n.severidade));
  if (avisos.length) {
    await avisar(d, "auditoria_achado", pushAgregado(avisos));
  }
}

// --------------------------------------------------------------- execução

/** Uma rodada por vez (o scheduler já evita sobreposição; isto cobre testes). */
export function criarMonitorEasypanel(d: MonitorDeps) {
  let rodando = false;
  return async (): Promise<ResumoMonitor | null> => {
    if (rodando) return null;
    rodando = true;
    try {
      return await monitorarEasypanel(d);
    } finally {
      rodando = false;
    }
  };
}
