// Cliente da API do EasyPanel: oRPC (POST /api/rpc/<roteador>/<proc>, corpo
// {"json":…}) e, para versões antigas, tRPC (GET /api/trpc/<a.b>?input=…);
// sempre com Authorization: Bearer. Defensivo: tenta os nomes conhecidos de
// cada procedimento (ver procedimentos.ts) nos dois transportes, lembra o que
// funcionou e degrada quando nenhum existe.
// Nunca registra corpo de resposta (pode conter env com segredos).
import {
  type GrupoProcedimento,
  INSPECIONAR_APP,
  INSPECIONAR_SERVICO,
  PROCEDIMENTOS,
  type Transporte,
  TRANSPORTES,
} from "./procedimentos.ts";

export type StatusApp = "running" | "stopped" | "error" | "unknown";

export type TipoErroEasypanel =
  | "auth"
  | "rede"
  | "http"
  | "formato"
  | "inexistente"
  | "config";

/** Mensagem sempre nossa (status/classe), nunca texto da resposta. */
export class ErroEasypanel extends Error {
  constructor(
    public tipo: TipoErroEasypanel,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ErroEasypanel";
  }
}

export interface AlvoServico {
  projeto: string;
  servico: string;
  tipo: string;
}

export interface ServicoEp extends AlvoServico {
  dominios: string[];
  /** false = parado no painel; null = desconhecido. */
  habilitado: boolean | null;
  /** Réplicas desejadas. */
  replicas: number | null;
  /** Env bruto ("CHAVE=valor" por linha). Só em memória: nunca gravar/logar. */
  env: string | null;
}

export interface Metricas {
  status: StatusApp | null;
  cpu: number | null;
  memBytes: number | null;
  memPct: number | null;
  replicasRodando: number | null;
}

export interface ClienteEasypanel {
  listar(): Promise<ServicoEp[]>;
  /** Detalhes de um serviço; undefined se o painel não tem o procedimento. */
  inspecionar(s: AlvoServico): Promise<Partial<ServicoEp> | undefined>;
  /** Métricas de todos os serviços ("projeto/serviço"); undefined se indisponível. */
  metricasTodas(): Promise<Map<string, Metricas> | undefined>;
  metricasServico(s: AlvoServico): Promise<Metricas | undefined>;
  /**
   * Valida o token com auth/getUser: "ok", "token_invalido" ou
   * "desconhecido" (procedimento inexistente nesta versão). Lança em erro de
   * rede/HTTP.
   */
  verificarToken(): Promise<SituacaoToken>;
  /** Grupo → nome que funcionou (null: nenhum respondeu). */
  procedimentos(): Record<string, string | null>;
  /** Transporte que respondeu por último (orpc ou trpc). */
  transporte(): Transporte | null;
}

export type SituacaoToken = "ok" | "token_invalido" | "desconhecido";

export interface OpcoesCliente {
  url: string;
  token: string;
  fetch?: typeof fetch;
  agora?: () => Date;
  timeoutMs?: number;
}

const PAUSA_INDISPONIVEL_MS = 60 * 60_000;

type Obj = Record<string, unknown>;
const ehObj = (x: unknown): x is Obj =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** Primeiro valor definido entre os caminhos ("a.b.c"). */
function pegar(o: unknown, ...caminhos: string[]): unknown {
  for (const c of caminhos) {
    let v: unknown = o;
    for (const k of c.split(".")) v = ehObj(v) ? v[k] : undefined;
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
function numero(o: unknown, ...caminhos: string[]): number | null {
  const v = pegar(o, ...caminhos);
  const n = typeof v === "string" ? Number(v.replace(/%$/, "")) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
function texto(o: unknown, ...caminhos: string[]): string | null {
  const v = pegar(o, ...caminhos);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Estado textual do Docker/EasyPanel → status do Vigia. */
export function mapearStatus(bruto: unknown): StatusApp | null {
  if (typeof bruto !== "string") return null;
  const s = bruto.toLowerCase();
  if (/^(running|healthy|up|ok|started|ready)/.test(s)) return "running";
  if (
    /^(exited|stopped|paused|created|complete|shutdown|disabled|idle)/.test(s)
  ) {
    return "stopped";
  }
  if (
    /^(failed|dead|error|rejected|unhealthy|restarting|orphaned|crash)/.test(s)
  ) {
    return "error";
  }
  return null;
}

function dominiosDe(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const d of x) {
    const h = typeof d === "string" ? d : texto(d, "host", "name", "domain");
    if (!h) continue;
    const limpo = h.toLowerCase().replace(/^https?:\/\//, "").split(/[/:]/)[0];
    if (limpo && !out.includes(limpo)) out.push(limpo);
  }
  return out;
}

function envDe(x: unknown): string | null {
  if (typeof x === "string") return x;
  if (ehObj(x)) {
    // Algumas versões devolvem objeto { CHAVE: valor }.
    return Object.entries(x).map(([k, v]) => `${k}=${String(v ?? "")}`)
      .join("\n");
  }
  return null;
}

function servicoDe(o: unknown, projetoPadrao?: string): ServicoEp | null {
  if (!ehObj(o)) return null;
  const projeto = texto(o, "projectName", "project.name", "project") ??
    projetoPadrao ?? null;
  const servico = texto(o, "name", "serviceName");
  if (!projeto || !servico) return null;
  const hab = pegar(o, "enabled");
  return {
    projeto,
    servico,
    tipo: texto(o, "type") ?? "app",
    dominios: dominiosDe(pegar(o, "domains")),
    habilitado: typeof hab === "boolean" ? hab : null,
    replicas: numero(o, "deploy.replicas", "replicas"),
    env: envDe(pegar(o, "env")),
  };
}

function metricasDe(o: unknown): Metricas {
  const stats = pegar(o, "stats") ?? o;
  return {
    status: mapearStatus(pegar(o, "state", "status", "containerState")),
    cpu: numero(stats, "cpu.percent", "cpuPercent", "cpu.usage", "cpu"),
    memBytes: numero(
      stats,
      "memory.usage",
      "memoryUsage",
      "mem.usage",
      "memory.used",
    ),
    memPct: numero(stats, "memory.percent", "memoryPercent", "mem.percent"),
    replicasRodando: numero(o, "runningReplicas", "replicas.running"),
  };
}

const soma = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : a + b;

/** Chave "projeto/serviço" de uma linha de métricas (campos ou nome Docker). */
function chaveMetricas(o: unknown, conhecidos: string[]): string | null {
  const p = texto(o, "projectName", "project");
  const s = texto(o, "serviceName", "service");
  if (p && s) return `${p}/${s}`;
  const nome = texto(o, "containerName", "service", "name", "id");
  if (!nome) return null;
  const base = nome.replace(/^\//, "").split(".")[0];
  // Docker Swarm: <projeto>_<serviço>.<réplica>.<id>
  return conhecidos.find((k) => k.replace("/", "_") === base) ??
    (base.includes("_")
      ? `${base.slice(0, base.indexOf("_"))}/${
        base.slice(base.indexOf("_") + 1)
      }`
      : null);
}

export function criarClienteEasypanel(o: OpcoesCliente): ClienteEasypanel {
  let base: URL;
  try {
    base = new URL(o.url);
  } catch {
    throw new ErroEasypanel("config", "EASYPANEL_URL inválida");
  }
  if (!/^https?:$/.test(base.protocol) || !o.token) {
    throw new ErroEasypanel(
      "config",
      "EASYPANEL_URL/EASYPANEL_TOKEN inválidos",
    );
  }
  const raiz = base.toString().replace(/\/+$/, "");
  const f = o.fetch ?? fetch;
  const agora = o.agora ?? (() => new Date());
  const funcionou: Record<string, string | null> = {};
  const indisponivelDesde = new Map<string, number>();
  const conhecidos: string[] = [];

  let transporte: Transporte | null = null;

  /** Uma chamada num transporte; erros sempre com mensagem nossa. */
  async function chamar(
    proc: string,
    t: Transporte,
    input?: unknown,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${o.token}`,
      Accept: "application/json",
    };
    let url: string;
    const init: RequestInit = {
      headers,
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    };
    if (t === "orpc") {
      url = `${raiz}/api/rpc/${proc}`;
      init.method = "POST";
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ json: input ?? undefined });
    } else {
      url = `${raiz}/api/trpc/${proc.replaceAll("/", ".")}?input=${
        encodeURIComponent(JSON.stringify({ json: input ?? null }))
      }`;
    }
    let r: Response;
    try {
      r = await f(url, init);
    } catch (e) {
      throw new ErroEasypanel(
        "rede",
        `EasyPanel inacessível (${(e as Error)?.name ?? "erro de rede"})`,
      );
    }
    let corpo: unknown;
    let jsonOk = true;
    try {
      corpo = JSON.parse(await r.text());
    } catch {
      jsonOk = false;
    }
    const codigo = r.ok ? null : texto(
      corpo,
      "error.json.data.code",
      "error.data.code",
      "json.code",
      "code",
    );
    if (r.status === 404 || codigo === "NOT_FOUND") {
      // Procedimento ausente nesta versão/transporte.
      throw new ErroEasypanel("inexistente", `${proc}: não encontrado`, 404);
    }
    if (
      r.status === 401 || r.status === 403 || codigo === "UNAUTHORIZED" ||
      codigo === "FORBIDDEN"
    ) {
      throw new ErroEasypanel(
        "auth",
        `EasyPanel recusou o token (HTTP ${r.status}): confira EASYPANEL_TOKEN`,
        r.status,
      );
    }
    if (r.status === 405) {
      throw new ErroEasypanel("inexistente", `${proc}: método não aceito`, 405);
    }
    if (!r.ok) {
      throw new ErroEasypanel("http", `${proc}: HTTP ${r.status}`, r.status);
    }
    if (!jsonOk) {
      // Ex.: a página HTML do painel no lugar da API.
      throw new ErroEasypanel("formato", `${proc}: resposta não é JSON`);
    }
    // tRPC: {result:{data:{json}}}; oRPC: {json, meta}; ou o JSON cru.
    const dados = pegar(corpo, "result.data");
    if (ehObj(corpo) && ehObj(corpo.result) && dados !== undefined) {
      return ehObj(dados) && "json" in dados ? dados.json : dados;
    }
    if (ehObj(corpo) && "json" in corpo) return corpo.json;
    return corpo;
  }

  /**
   * Tenta os candidatos em cada transporte (o que já funcionou primeiro);
   * undefined se nenhum existe (pausa de 1 h). Resposta fora do formato
   * conta como "não existe neste transporte".
   */
  async function tentar(
    grupo: GrupoProcedimento,
    candidatos: readonly string[],
    input?: unknown,
  ): Promise<unknown | undefined> {
    const desde = indisponivelDesde.get(grupo);
    if (
      desde !== undefined && agora().getTime() - desde < PAUSA_INDISPONIVEL_MS
    ) {
      return undefined;
    }
    const lembrado = funcionou[grupo];
    const ordem = lembrado
      ? [lembrado, ...candidatos.filter((c) => c !== lembrado)]
      : [...candidatos];
    const transportes = transporte
      ? [transporte, ...TRANSPORTES.filter((t) => t !== transporte)]
      : [...TRANSPORTES];
    for (const p of ordem) {
      for (const t of transportes) {
        try {
          const r = await chamar(p, t, input);
          funcionou[grupo] = p;
          transporte = t;
          indisponivelDesde.delete(grupo);
          return r;
        } catch (e) {
          if (
            e instanceof ErroEasypanel &&
            (e.tipo === "inexistente" || e.tipo === "formato")
          ) continue;
          throw e;
        }
      }
    }
    funcionou[grupo] = null;
    indisponivelDesde.set(grupo, agora().getTime());
    return undefined;
  }

  const lembrar = (s: ServicoEp[]) => {
    conhecidos.splice(
      0,
      conhecidos.length,
      ...s.map((x) => `${x.projeto}/${x.servico}`),
    );
    return s;
  };

  return {
    async listar() {
      const r = await tentar("listar", PROCEDIMENTOS.listar);
      if (r !== undefined) {
        const servicos = Array.isArray(r) ? r : pegar(r, "services");
        if (!Array.isArray(servicos)) {
          throw new ErroEasypanel("formato", "lista de serviços ausente");
        }
        return lembrar(
          servicos.map((x) => servicoDe(x)).filter((x): x is ServicoEp => !!x),
        );
      }
      const ps = await tentar("listarProjetos", PROCEDIMENTOS.listarProjetos);
      const projetos = Array.isArray(ps) ? ps : pegar(ps, "projects");
      if (!Array.isArray(projetos)) {
        throw new ErroEasypanel(
          "formato",
          "nenhum procedimento de listagem respondeu (veja procedimentos.ts)",
        );
      }
      const out: ServicoEp[] = [];
      for (const p of projetos) {
        const nome = typeof p === "string" ? p : texto(p, "name");
        if (!nome) continue;
        const ip = await tentar(
          "inspecionarProjeto",
          PROCEDIMENTOS.inspecionarProjeto,
          { projectName: nome },
        );
        const sv = pegar(ip, "services");
        if (!Array.isArray(sv)) continue;
        for (const s of sv) {
          const x = servicoDe(s, nome);
          if (x) out.push({ ...x, projeto: nome });
        }
      }
      return lembrar(out);
    },

    async inspecionar(s) {
      const cands = [
        ...INSPECIONAR_SERVICO.map((c) => c.replace("{tipo}", s.tipo)),
        ...(s.tipo === "app" ? INSPECIONAR_APP : []),
      ];
      const r = await tentar(`inspecionar:${s.tipo}`, cands, {
        projectName: s.projeto,
        serviceName: s.servico,
      });
      if (r === undefined) return undefined;
      const x = servicoDe(r, s.projeto);
      if (!x) return {};
      const out: Partial<ServicoEp> = {};
      if (pegar(r, "domains") !== undefined) out.dominios = x.dominios;
      if (x.habilitado !== null) out.habilitado = x.habilitado;
      if (x.replicas !== null) out.replicas = x.replicas;
      if (x.env !== null) out.env = x.env;
      return out;
    },

    async metricasTodas() {
      const r = await tentar("metricasTodas", PROCEDIMENTOS.metricasTodas);
      if (r === undefined) return undefined;
      const linhas = Array.isArray(r)
        ? r
        : (pegar(r, "containers", "services", "items") as
          | unknown[]
          | undefined);
      if (!Array.isArray(linhas)) return undefined;
      const m = new Map<string, Metricas>();
      for (const l of linhas) {
        const k = chaveMetricas(l, conhecidos);
        if (!k) continue;
        const x = metricasDe(l);
        const ant = m.get(k);
        if (!ant) {
          m.set(k, {
            ...x,
            replicasRodando: x.replicasRodando ??
              (x.status === "running" ? 1 : 0),
          });
          continue;
        }
        // Várias réplicas: soma uso; rodando se alguma roda.
        const rodando = x.status === "running" ? 1 : 0;
        m.set(k, {
          status: ant.status === "running" || x.status === "running"
            ? "running"
            : (ant.status ?? x.status),
          cpu: soma(ant.cpu, x.cpu),
          memBytes: soma(ant.memBytes, x.memBytes),
          memPct: soma(ant.memPct, x.memPct),
          replicasRodando: (ant.replicasRodando ?? 0) + rodando,
        });
      }
      return m;
    },

    async metricasServico(s) {
      const r = await tentar("metricasServico", PROCEDIMENTOS.metricasServico, {
        projectName: s.projeto,
        serviceName: s.servico,
      });
      return r === undefined ? undefined : metricasDe(r);
    },

    async verificarToken() {
      try {
        const r = await tentar("usuario", PROCEDIMENTOS.usuario);
        if (r === undefined) return "desconhecido";
        const u = ehObj(r) && "user" in r ? r.user : r;
        return ehObj(u) && Object.keys(u).length ? "ok" : "token_invalido";
      } catch (e) {
        if (e instanceof ErroEasypanel && e.tipo === "auth") {
          return "token_invalido";
        }
        throw e;
      }
    },

    procedimentos: () => ({ ...funcionou }),
    transporte: () => transporte,
  };
}
