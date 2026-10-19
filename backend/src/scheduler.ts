import type { Sql } from "./db/client.ts";
import {
  type Evento,
  type Incidente,
  type Sinal,
  soBorda,
} from "./monitor/types.ts";
import { type Parecer, textoPush } from "./ai/triage.ts";
import type { JevSaida } from "./ai/schemas.ts";
import type { Notificacao, TipoEvento } from "./notify/notifier.ts";
import { descartarConexao, IpProtegido } from "./monitor/executor.ts";
import {
  ACOES_BARRADAS,
  barradoPelaGeo,
  type CtxPassou,
  DESCRICAO_GEO,
  passouGeo,
  resumoEstrangeiros,
} from "./monitor/estrangeiro.ts";
import type { DadosIp } from "./ip/localizar.ts";
import {
  asnsDatacenterAtivos,
  FAIXA_CONECTOR_PADRAO,
} from "./monitor/geoblock.ts";
import { faixasConectorTabela } from "./monitor/vendores.ts";
import { detectarConectores, registrarPedido } from "./auditoria/conector.ts";
import {
  bloqueiosAtivos,
  type InfoBloqueio,
  infoBloqueios,
  rotuloDuracao,
} from "./monitor/origem_bloqueio.ts";
import {
  dataCurta,
  linhasStatus,
  locaisParaPush,
  type StatusIp,
  tituloIps,
} from "./notify/alerta.ts";
import { VIGIA_HOST_PADRAO } from "./config.ts";
import { jobAuditoria, type JobAuditoriaDeps } from "./auditoria/execucao.ts";
import { ipsAdminVigentes } from "./monitor/ips_admin.ts";
import {
  ehAuditoriaPropria,
  ipsServidorVigentes,
} from "./monitor/ip_servidor.ts";
import {
  detectar as detectarPadrao,
  medianaPorHost,
} from "./monitor/detector.ts";
import {
  agrupar,
  anexarEncerrados,
  carregarAbertos,
  carregarEncerradosRecentes,
  carregarPendentes,
  normalizarIp,
  persistirIncidentes,
} from "./monitor/grouper.ts";
import {
  CLOUDFLARE_IPS_PADRAO,
  decidir,
  type Decisao,
  limiarJev,
  rotuloModelo,
} from "./monitor/decision.ts";

// ------------------------------------------------------------------ tipos

export interface CicloDeps {
  sql: Sql;
  agora: () => Date;
  /** executarColeta (grava eventos e atualiza coletor_falhas/coletor_ultimo_ok). */
  coletar: () => Promise<unknown>;
  triar: (
    incidentes: Incidente[],
    eventos: Evento[],
  ) => Promise<
    {
      anomalias: JevSaida["anomalias"];
      pareceres: Map<string, Parecer[]>;
      /** Chaves não triadas neste ciclo (limite); voltam no próximo. */
      adiados?: string[];
    }
  >;
  bloquear: (
    ip: string,
    incidenteId: number,
    motivo: string,
    dias?: number,
    /** Regra automática que bloqueou (vira o ator da auditoria). */
    regra?: "jev" | "reserva",
  ) => Promise<{ bloqueioId: number }>;
  /** Localização com cache de 7 dias (localizarIp); ausente: só o Cloudflare. */
  localizar?: (ip: string) => Promise<DadosIp>;
  /** Orçamento total das localizações de um push (padrão 3 s). */
  orcamentoLocalMs?: number;
  /** Nunca deve lançar (notificar real já engole erros). */
  notificar: (tipo: TipoEvento, n: Notificacao) => Promise<unknown>;
  ehBotVerificado: (ip: string, ua: string) => Promise<boolean>;
  /** Host do próprio Vigia (nunca conta como acesso estrangeiro que passou). */
  vigiaHost?: string;
  /** Passada só do Jev (monitorarTrafego) quando não há incidentes a triar. */
  monitorar: (eventos: Evento[]) => Promise<JevSaida["anomalias"]>;
  detectar?: typeof detectarPadrao;
}

export interface ResultadoCiclo {
  executado: boolean;
  eventos?: number;
  sinais?: number;
  incidentes?: number;
  decisoes?: { incidenteId: number; acao: Decisao["acao"] }[];
}

// ------------------------------------------------------------------ config

export const CHAVE_LOCK_CICLO = "vigia:ciclo";
const FALHAS_COLETOR_AVISO = 5;
const MAX_EVENTOS_CICLO = 50_000;
const JANELA_INICIAL_MS = 10 * 60_000;
const JANELA_VOLUME_MS = 5 * 60_000;
const MAX_IPS_BLOQUEIO = 20;
const RETENCAO_DIAS = 30;
const LIMIAR_BRUTEFORCE_PADRAO = 20;
const LIMIAR_RATE_PADRAO = 10;
const JEV_MONITOR_MIN = 5;

type ConfigGeral = Map<string, unknown>;

export async function lerConfigGeral(sql: Sql): Promise<ConfigGeral> {
  const rows = await sql`SELECT chave, valor FROM vigia.config_geral
    WHERE chave NOT LIKE 'notif_ultimo:%' AND chave NOT LIKE 'aviso:%'`;
  return new Map(rows.map((r) => [String(r.chave), r.valor]));
}

export async function gravarConfig(sql: Sql, chave: string, valor: unknown) {
  await sql`INSERT INTO vigia.config_geral (chave, valor)
    VALUES (${chave}, ${sql.json(valor as never)})
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
}

export function emObservacao(cfg: ConfigGeral, agora: Date): boolean {
  const ate = cfg.get("modo_observacao_ate");
  if (typeof ate !== "string") return false;
  const t = new Date(ate).getTime();
  return Number.isFinite(t) && agora.getTime() < t;
}

export const flag = (cfg: ConfigGeral, chave: string) =>
  cfg.get(chave) === true;

export function limiares(cfg: ConfigGeral) {
  const n = (k: string, d: number) => {
    const v = Number(cfg.get(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    bruteforceN: n("limiar_bruteforce_n", LIMIAR_BRUTEFORCE_PADRAO),
    rateK: n("limiar_rate_k", LIMIAR_RATE_PADRAO),
  };
}

/** Regra de decisão do Jev (jev_limiar, jev_exige_segunda) e bloqueio de datacenter. */
export function configDecisao(cfg: ConfigGeral) {
  return {
    jevLimiar: limiarJev(cfg.get("jev_limiar")),
    jevExigeSegunda: cfg.get("jev_exige_segunda") === true,
    /** Padrão ligado: só false explícito desliga. */
    bloquearDatacenter: cfg.get("bloquear_datacenter") !== false,
  };
}

/** Check-and-set atômico em config_geral[chave]: true se ganhou a janela. */
export async function reservarJanela(
  sql: Sql,
  chave: string,
  minutos: number,
  agora: Date,
): Promise<boolean> {
  const limite = new Date(agora.getTime() - minutos * 60_000);
  const rows = await sql`
    INSERT INTO vigia.config_geral (chave, valor)
    VALUES (${chave}, to_jsonb(${agora.toISOString()}::text))
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
    WHERE (vigia.config_geral.valor #>> '{}')::timestamptz <= ${limite.toISOString()}::timestamptz
    RETURNING chave`;
  return rows.length > 0;
}

/** Janela de aviso (chave prefixada com "aviso:"). */
export function reservarAviso(
  sql: Sql,
  chave: string,
  minutos: number,
  agora: Date,
): Promise<boolean> {
  return reservarJanela(sql, "aviso:" + chave, minutos, agora);
}

/** Permitidos não expirados (IP sem /32,/128 ou CIDR). */
export async function permitidosVigentes(
  sql: Sql,
  agora: Date,
): Promise<string[]> {
  const rows = await sql`
    SELECT regexp_replace(ip::text, '/(32|128)$', '') ip FROM vigia.permitidos
    WHERE expira IS NULL OR expira > ${agora}`;
  return rows.map((r) => String(r.ip));
}

/** IPs com bloqueio vigente (não removido e não vencido), normalizados. */
export async function ipsBloqueadosAtivos(
  sql: Sql,
  agora: Date,
): Promise<Set<string>> {
  const rows = await sql`SELECT DISTINCT host(ip) ip FROM vigia.bloqueios
    WHERE removido IS NULL AND (expira IS NULL OR expira > ${agora})`;
  return new Set(rows.map((r) => normalizarIp(String(r.ip))));
}

// ------------------------------------------------------------------ lock

async function comLockCiclo<T>(
  sql: Sql,
  fn: () => Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false }> {
  const c = await sql.reserve();
  try {
    await c`SET lock_timeout = '30s'`;
    const [r] = await c`SELECT pg_backend_pid() AS pid,
      pg_try_advisory_lock(hashtext(${CHAVE_LOCK_CICLO})) AS ok`;
    if (!r?.ok) return { ok: false };
    const pid = Number(r.pid);
    try {
      return { ok: true, valor: await fn() };
    } finally {
      try {
        await c`SELECT pg_advisory_unlock(hashtext(${CHAVE_LOCK_CICLO}))`;
        await c`RESET lock_timeout`;
      } catch (e) {
        console.error(`scheduler: unlock falhou: ${(e as Error).message}`);
        await descartarConexao(sql, pid);
      }
    }
  } finally {
    c.release();
  }
}

// ------------------------------------------------------------------ eventos

// deno-lint-ignore no-explicit-any
const linhaEvento = (r: any): Evento => ({
  zonaId: Number(r.zona_id),
  ts: new Date(r.ts),
  ip: String(r.ip),
  pais: r.pais ?? "",
  asn: Number(r.asn ?? 0) || 0,
  host: r.host ?? "",
  caminho: r.caminho ?? "",
  metodo: r.metodo ?? "",
  status: Number(r.status ?? 0),
  ua: r.ua ?? "",
  acaoCf: r.acao_cf ?? "",
  fonte: r.fonte,
  contagem: Number(r.contagem ?? 1),
  ...(r.regra_cf ? { regraCf: String(r.regra_cf) } : {}),
});

/**
 * `eventos`: novos desde a marca d'água (todas as fontes).
 * `janela`: eventos http dos últimos 5 min já processados (contexto para as
 * regras de volume), sem repetir os novos.
 */
async function carregarEventos(
  sql: Sql,
  agora: Date,
): Promise<{ eventos: Evento[]; janela: Evento[]; ultimoId: number | null }> {
  const [w] = await sql`SELECT valor FROM vigia.config_geral
    WHERE chave = 'ciclo_ultimo_evento_id'`;
  const desdeId = Number(w?.valor ?? 0) || 0;
  // Nunca reprocessa backlog antigo (ex.: primeiro ciclo ou após parada longa).
  const desdeTs = new Date(agora.getTime() - JANELA_INICIAL_MS);
  const rows = await sql`
    SELECT id, zona_id, ts, host(ip) ip, pais, asn, host, caminho, metodo,
      status, ua, acao_cf, regra_cf, fonte, contagem
    FROM vigia.eventos
    WHERE id > ${desdeId} AND ts >= ${desdeTs}
    ORDER BY id LIMIT ${MAX_EVENTOS_CICLO}`;
  const eventos = rows.map(linhaEvento);
  const desdeVolume = new Date(agora.getTime() - JANELA_VOLUME_MS);
  const ant = await sql`
    SELECT id, zona_id, ts, host(ip) ip, pais, asn, host, caminho, metodo,
      status, ua, acao_cf, fonte, contagem
    FROM vigia.eventos
    WHERE fonte = 'http' AND id <= ${desdeId} AND ts >= ${desdeVolume}
    ORDER BY id DESC LIMIT ${MAX_EVENTOS_CICLO}`;
  const janela = ant.map(linhaEvento);
  let ultimoId: number | null = rows.length
    ? Number(rows[rows.length - 1].id)
    : null;
  if (ultimoId === null && desdeId === 0) {
    // sem marca ainda: ancora no maior id existente
    const [m] = await sql`SELECT max(id) m FROM vigia.eventos`;
    ultimoId = m?.m ? Number(m.m) : null;
  }
  return { eventos, janela, ultimoId };
}

const TIPOS_VOLUME = new Set<Sinal["tipo"]>(["bruteforce", "rate", "scrape"]);
const grupoDe = (x: { zonaId: number; host: string; ip: string }) =>
  `${x.zonaId}|${x.host}|${normalizarIp(x.ip)}`;

/**
 * Regras por evento (geo/scan/ua) só sobre os eventos novos; regras de volume
 * sobre novos + janela de 5 min, mantendo só grupos com evento novo e com a
 * contagem limitada ao que é novo (o agrupador soma ao incidente aberto).
 */
export function detectarComJanela(
  detectar: typeof detectarPadrao,
  novos: Evento[],
  janela: Evento[],
  ctx: Omit<Parameters<typeof detectarPadrao>[1], "medianaPorHost">,
): Sinal[] {
  const todos = [...novos, ...janela];
  const ctxCompleto = { ...ctx, medianaPorHost: medianaPorHost(todos) };
  if (janela.length === 0) return detectar(novos, ctxCompleto);
  const porEvento = detectar(novos, ctxCompleto).filter((s) =>
    !TIPOS_VOLUME.has(s.tipo)
  );
  const novoPorGrupo = new Map<string, number>();
  for (const e of novos) {
    if (e.fonte !== "http") continue;
    const k = grupoDe(e);
    novoPorGrupo.set(k, (novoPorGrupo.get(k) ?? 0) + e.contagem);
  }
  const volume = detectar(todos, ctxCompleto)
    .filter((s) => TIPOS_VOLUME.has(s.tipo) && novoPorGrupo.has(grupoDe(s)))
    .map((s) => ({
      ...s,
      contagem: Math.min(s.contagem, novoPorGrupo.get(grupoDe(s))!),
    }));
  return [...porEvento, ...volume];
}

// ------------------------------------------------------------------ ciclo

const tiposDe = (i: Incidente) =>
  [...new Set(i.sinais.map((s) => s.tipo))].sort().join(",");

/** Novo, ou mudou o conjunto de tipos de sinal / a severidade máxima. */
function precisaTriagem(inc: Incidente, antes: Map<number, Incidente>) {
  if (soBorda(inc.sinais)) {
    return false; // só geo/datacenter: decidir sempre registra; não gasta IA
  }
  const a = inc.id !== undefined ? antes.get(inc.id) : undefined;
  if (!a) return true;
  return a.severidadeMax !== inc.severidadeMax || tiposDe(a) !== tiposDe(inc);
}

async function salvarPareceres(sql: Sql, incidenteId: number, ps: Parecer[]) {
  if (ps.length === 0) return;
  const rows = ps.map((p) => ({
    incidente_id: incidenteId,
    papel: p.papel,
    modelo: p.modelo,
    classe: p.ok ? p.classe : null,
    confianca: p.ok ? p.confianca : null,
    justificativa: p.justificativa,
    latencia_ms: p.latenciaMs ?? null,
    ok: p.ok,
  }));
  await sql`INSERT INTO vigia.pareceres_ia ${sql(rows)}`;
}

async function salvarDecisao(
  sql: Sql,
  incidenteId: number,
  d: Decisao,
  status: string | null,
  agora: Date,
  extra: Record<string, unknown> = {},
) {
  const decisao = { ...d, ts: agora.toISOString(), ...extra };
  await sql`UPDATE vigia.incidentes SET
      classe_final = ${d.classe},
      decisao = ${sql.json(decisao as never)},
      status = COALESCE(${status}, status),
      triagem_pendente = false
    WHERE id = ${incidenteId}`;
}

/**
 * Agregado por zona, enviado no FIM do ciclo (depois da triagem e das decisões):
 * "N IPs estrangeiros bloqueados em <zona>" + aviso dos acessos que passaram.
 * IPs com triagem adiada ficam fora do aviso (sem push antes da classificação).
 */
async function avisarEstrangeiros(
  deps: CicloDeps,
  eventos: Evento[],
  ctx: CtxPassou,
  semTriagem: Set<string>,
) {
  const zonas = resumoEstrangeiros(eventos, ctx).map((z) => ({
    ...z,
    passaram: z.passaram.filter((p) => !semTriagem.has(normalizarIp(p.ip))),
  })).filter((z) => z.ipsBarrados.size > 0 || z.passaram.length > 0);
  if (zonas.length === 0) return;
  const nomes = new Map(
    (await deps.sql`SELECT id, nome FROM vigia.zonas`).map((
      r,
    ) => [Number(r.id), String(r.nome)]),
  );
  // País/ASN que o Cloudflare deu (reserva da localização) e volume por IP.
  const cf = new Map<string, { pais: string; asn: number }>();
  for (const e of eventos) {
    const c = cf.get(e.ip);
    if (!c) cf.set(e.ip, { pais: e.pais, asn: e.asn });
    else {
      if (!c.pais && e.pais) c.pais = e.pais;
      if (!c.asn && e.asn) c.asn = e.asn;
    }
  }
  const topo = (porIp: Map<string, number>) =>
    [...porIp].sort((a, b) => b[1] - a[1]).map(([ip]) => ip);
  const locais = (ips: string[]) =>
    locaisParaPush(ips, {
      localizar: deps.localizar,
      orcamentoMs: deps.orcamentoLocalMs,
      cloudflare: cf,
      comIp: true,
    });
  for (const z of zonas) {
    const nome = nomes.get(z.zonaId) ?? `zona ${z.zonaId}`;
    const n = z.ipsBarrados.size;
    if (n > 0) {
      const porIp = new Map<string, number>();
      for (const e of eventos) {
        if (e.zonaId === z.zonaId && barradoPelaGeo(e)) {
          porIp.set(e.ip, (porIp.get(e.ip) ?? 0) + (e.contagem || 1));
        }
      }
      await deps.notificar("estrangeiro_agregado", {
        titulo: n === 1
          ? `1 IP estrangeiro bloqueado em ${nome}`
          : `${n} IPs estrangeiros bloqueados em ${nome}`,
        corpo: [
          `${z.reqBarradas} requisição(ões) barrada(s) pela regra Fora do Brasil.`,
          ...await locais(topo(porIp)),
        ].join("\n"),
        url: "/incidentes",
        chaveAgregacao: String(z.zonaId),
      });
    }
    if (z.passaram.length > 0) {
      // Chave própria: a janela do agregado de bloqueados não engole o aviso.
      const linhas = z.passaram.slice(0, 3).map((p) =>
        `⚠️ Acesso estrangeiro passou: ${p.ip} ${
          p.caminho.slice(0, 120)
        } (HTTP ${p.status})`
      );
      if (z.passaram.length > 3) {
        linhas.push(`⚠️ e mais ${z.passaram.length - 3} acesso(s).`);
      }
      const porIp = new Map<string, number>();
      for (const p of z.passaram) porIp.set(p.ip, (porIp.get(p.ip) ?? 0) + p.n);
      linhas.push(...await locais(topo(porIp)));
      await deps.notificar("estrangeiro_agregado", {
        titulo: `Acesso estrangeiro passou em ${nome}`,
        corpo: linhas.join("\n"),
        url: "/incidentes",
        chaveAgregacao: `${z.zonaId}:passou`,
      });
    }
  }
}

const ROTULO_CLASSE: Record<string, string> = {
  invasao: "Invasão",
  raspagem: "Raspagem",
  forca_bruta: "Força bruta",
  varredura: "Varredura",
  credential_stuffing: "Credential stuffing",
  benigno: "Benigno",
  incerto: "Incerto",
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const duracaoTxt = (dias: number) => dias === 1 ? "24 h" : `${dias} dias`;

/**
 * 1ª linha do push: "Varredura · Jev 86% · DeepSeek 78% · GLM ausente (timeout) ·
 * bloqueado 7 dias". Cada IA aparece pelo modelo configurado no papel
 * (rotuloModelo); IA com outra classe aparece com a classe dela.
 */
export function resumoPush(
  d: Decisao,
  pareceres: Parecer[],
  desfecho: string,
): string {
  const partes = [ROTULO_CLASSE[d.classe] ?? d.classe];
  for (const papel of ["jev", "segunda", "terceira"]) {
    const p = pareceres.find((x) => x.papel === papel);
    if (!p) continue;
    const nome = rotuloModelo(p.modelo, papel);
    if (!p.ok) {
      const m = p.justificativa.match(/^falha: (.+)$/);
      partes.push(`${nome} ausente (${m ? m[1] : "sem classificação"})`);
    } else if (p.classe !== d.classe) {
      partes.push(
        `${nome} ${(ROTULO_CLASSE[p.classe] ?? p.classe).toLowerCase()} ${
          pct(p.confianca)
        }`,
      );
    } else partes.push(`${nome} ${pct(p.confianca)}`);
  }
  partes.push(desfecho);
  return partes.join(" · ");
}

/**
 * Push de anomalia a partir da resposta do Jev — texto influenciável por quem
 * gera o tráfego. O host só aparece se foi visto no ciclo (o modelo não inventa
 * destino) e a descrição vai neutralizada, curta e sem link clicável.
 */
export function avisoAnomalia(
  a: JevSaida["anomalias"][number],
  hostsVistos: ReadonlySet<string>,
): { titulo: string; corpo: string; chaveAgregacao: string } {
  const host = hostsVistos.has(a.host) ? a.host : "";
  return {
    titulo: host ? `Anomalia em ${host}` : "Anomalia no tráfego",
    corpo: textoPush(a.descricao),
    chaveAgregacao: host || "anomalia",
  };
}

async function avisarAnomalias(
  deps: CicloDeps,
  anomalias: JevSaida["anomalias"],
  hostsVistos: ReadonlySet<string>,
) {
  for (const a of anomalias) {
    if (a.gravidade !== "media" && a.gravidade !== "alta") continue;
    await deps.notificar("anomalia", {
      ...avisoAnomalia(a, hostsVistos),
      url: "/",
    });
  }
}

/**
 * Transações de conector de origem desconhecida: registra um pedido por faixa e
 * pergunta ao usuário por push (temporário/permanente/bloquear). Uma vez por
 * faixa (índice único). Nunca lança — detecção é melhor-esforço.
 */
async function avisarConectores(
  deps: CicloDeps,
  eventos: Evento[],
  ctx: { vigiaHost: string; asnsDatacenter: ReadonlySet<number> },
): Promise<void> {
  try {
    const conhecidos = [
      ...FAIXA_CONECTOR_PADRAO,
      ...await faixasConectorTabela(deps.sql),
    ];
    for (const a of detectarConectores(eventos, { ...ctx, conhecidos })) {
      const id = await registrarPedido(deps.sql, a);
      if (id === null) continue; // já perguntado para essa faixa
      await deps.notificar("conector_pedido", {
        titulo: "🔌 Conector novo quer acessar",
        corpo: [
          `Origem: ${a.origem || a.ip}`,
          `Caminho: ${textoPush(a.caminho, 120)}`,
          `Faixa: ${a.faixa}`,
          "Liberar temporário, permanente ou bloquear?",
        ].join("\n"),
        url: `/conector?pedido=${id}`,
        acoes: [
          { acao: "conector_tmp", titulo: "Temporário" },
          { acao: "conector_perm", titulo: "Permanente" },
          { acao: "conector_bloq", titulo: "Bloquear" },
        ],
        chaveAgregacao: a.faixa,
      });
    }
  } catch (e) {
    console.error(`scheduler: conector: ${(e as Error).message}`);
  }
}

async function verificarColetor(deps: CicloDeps, agora: Date) {
  const zonas = await deps.sql`
    SELECT z.nome, (c.valor->>'n')::int n FROM vigia.config_geral c
    JOIN vigia.zonas z ON z.id = substr(c.chave, length('coletor_falhas:') + 1)::int
    WHERE c.chave ~ '^coletor_falhas:[0-9]+$' AND z.ativa
      AND (c.valor->>'n')::int >= ${FALHAS_COLETOR_AVISO}
    ORDER BY z.nome`;
  const [r] = await deps.sql`SELECT valor FROM vigia.config_geral
    WHERE chave = 'coletor_falhas'`;
  const falhas = Number(r?.valor ?? 0) || 0;
  if (zonas.length === 0 && falhas < FALHAS_COLETOR_AVISO) return;
  if (!await reservarAviso(deps.sql, "coletor", 60, agora)) return;
  const corpo = zonas.length > 0
    ? `Falhas seguidas ao ler o Cloudflare: ${
      zonas.map((z) => `${z.nome} (${z.n})`).join(", ")
    }. Verifique o token e a conexão.`
    : `${falhas} falhas seguidas ao ler o Cloudflare. Verifique o token e a conexão.`;
  await deps.notificar("coletor_parado", {
    titulo: "Coletor parado",
    corpo,
    url: "/",
    chaveAgregacao: "coletor",
  });
}

/** País/ASN mais recentes que o Cloudflare deu e requisições barradas pela regra geo (24 h). */
async function contextoCloudflare(
  sql: Sql,
  ips: string[],
  agora: Date,
): Promise<{
  local: Map<string, { pais: string; asn: number }>;
  barradas: Map<string, number>;
}> {
  const local = new Map<string, { pais: string; asn: number }>();
  const barradas = new Map<string, number>();
  const norm = [...new Set(ips.map(normalizarIp))];
  if (norm.length === 0) return { local, barradas };
  const rows = await sql`
    SELECT host(ip) ip,
      coalesce(sum(contagem) FILTER (WHERE fonte = 'firewall'
        AND regra_cf = ${DESCRICAO_GEO}
        AND lower(acao_cf) = ANY(${ACOES_BARRADAS}::text[])), 0)::int barradas,
      (array_agg(pais ORDER BY ts DESC) FILTER (WHERE coalesce(pais, '') <> ''))[1] pais,
      (array_agg(asn ORDER BY ts DESC) FILTER (WHERE asn > 0))[1] asn
    FROM vigia.eventos
    WHERE ip = ANY(${norm}::inet[]) AND ts >= ${new Date(
    agora.getTime() - 86_400_000,
  )}
    GROUP BY ip`;
  for (const r of rows) {
    const ip = normalizarIp(String(r.ip));
    barradas.set(ip, Number(r.barradas));
    local.set(ip, { pais: String(r.pais ?? ""), asn: Number(r.asn ?? 0) || 0 });
  }
  return { local, barradas };
}

/** Status de cada IP do incidente para a 1ª linha do push. */
export function montarStatus(
  ips: string[],
  o: {
    /** Bloqueados neste ciclo → vencimento. */
    bloqueados?: Map<string, Date | null>;
    dias?: number;
    regra?: "jev" | "reserva";
    /** Motivo por IP quando o bloqueio falhou/foi recusado. */
    erros?: Map<string, string>;
    /** Bloqueios vigentes ANTES desta decisão (IP normalizado). */
    antes: Map<string, InfoBloqueio>;
    /** Requisições barradas pela regra geo (IP normalizado). */
    barradas: Map<string, number>;
    motivoNao: string;
  },
): Map<string, StatusIp> {
  const out = new Map<string, StatusIp>();
  for (const ip of ips) {
    const k = normalizarIp(ip);
    const ant = o.antes.get(k);
    if (o.bloqueados?.has(ip)) {
      const ate = o.bloqueados.get(ip) ?? null;
      out.set(
        ip,
        ant
          ? { tipo: "ja_bloqueado", ate: ate ?? ant.expira, por: ant.origem }
          : {
            tipo: "bloqueado",
            dias: o.dias ?? 7,
            ate,
            por: o.regra ?? "reserva",
          },
      );
    } else if (ant) {
      out.set(ip, { tipo: "ja_bloqueado", ate: ant.expira, por: ant.origem });
    } else if ((o.barradas.get(k) ?? 0) > 0) {
      out.set(ip, { tipo: "geo", barradas: o.barradas.get(k)! });
    } else {
      out.set(ip, { tipo: "nao", motivo: o.erros?.get(ip) ?? o.motivoNao });
    }
  }
  return out;
}

/** "modo observação até 03/10 10:00" ("sem prazo" quando ligado sem fim). */
function textoObservacao(ate: unknown): string {
  const d = typeof ate === "string" ? new Date(ate) : null;
  if (!d || !Number.isFinite(d.getTime()) || d.getUTCFullYear() >= 9999) {
    return "modo observação (sem prazo)";
  }
  return `modo observação até ${dataCurta(d)}`;
}

function prefixoSugestao(status: StatusIp[], observacao: boolean): string {
  if (status.length > 0 && status.every((s) => s.tipo !== "nao")) {
    if (status.every((s) => s.tipo === "ja_bloqueado")) {
      return "🔒 Sugestão (já bloqueado)";
    }
    if (status.every((s) => s.tipo === "geo")) {
      return "🌎 Sugestão (barrado pela regra Fora do Brasil)";
    }
    return "🔒 Sugestão (já barrado)";
  }
  return observacao
    ? "⚠️ Teria bloqueado (não bloqueado)"
    : "⚠️ Sugestão (não bloqueado)";
}

async function executarDecisao(
  deps: CicloDeps,
  inc: Incidente & { id: number },
  d: Decisao,
  autoAtivo: boolean,
  agora: Date,
  pareceres: Parecer[],
  observacaoAte: unknown,
): Promise<Decisao> {
  let dec = d;
  if (dec.acao === "bloquear" && !autoAtivo) {
    dec = {
      ...dec,
      acao: "sugerir",
      motivo: `Teria bloqueado: ${dec.motivo}`,
      observacao: true,
      naoBloqueou: "bloqueio automático desligado",
    };
  }
  if (dec.acao === "registrar") {
    await salvarDecisao(deps.sql, inc.id, dec, null, agora);
    return dec;
  }
  const motivoNao = dec.observacao
    ? (autoAtivo
      ? textoObservacao(observacaoAte)
      : "bloqueio automático desligado")
    : dec.naoBloqueou ?? "nenhuma regra de bloqueio atingida";
  // Estado ANTES de bloquear (quem já bloqueou) e o que o Cloudflare viu.
  // Falha aqui nunca impede a decisão nem o push.
  let antes = new Map<string, InfoBloqueio>();
  let cf: Awaited<ReturnType<typeof contextoCloudflare>> = {
    local: new Map(),
    barradas: new Map(),
  };
  try {
    antes = await bloqueiosAtivos(deps.sql, inc.ips, agora);
    cf = await contextoCloudflare(deps.sql, inc.ips, agora);
  } catch (e) {
    console.error(`scheduler: contexto do push: ${(e as Error).message}`);
  }
  const cfPorIp = new Map<string, { pais: string; asn: number }>();
  for (const ip of inc.ips) {
    const v = cf.local.get(normalizarIp(ip));
    if (v) cfPorIp.set(ip, v);
  }
  const locais = () =>
    locaisParaPush(inc.ips, {
      localizar: deps.localizar,
      orcamentoMs: deps.orcamentoLocalMs,
      cloudflare: cfPorIp,
      comIp: inc.ips.length > 1,
    });
  const dias = dec.dias ?? 7;

  if (dec.acao === "bloquear") {
    const ids: number[] = [];
    const idPorIp = new Map<string, number>();
    const erros = new Map<string, string>();
    let erro: string | null = null;
    for (const ip of inc.ips.slice(0, MAX_IPS_BLOQUEIO)) {
      try {
        const id = (await deps.bloquear(
          ip,
          inc.id,
          dec.motivo,
          dias,
          dec.regra ?? "reserva",
        )).bloqueioId;
        ids.push(id);
        idPorIp.set(ip, id);
      } catch (e) {
        erro = (e as Error).message;
        erros.set(
          ip,
          e instanceof IpProtegido
            ? "IP protegido"
            : `falha ao bloquear: ${erro}`,
        );
        console.error(`scheduler: bloquear ${ip} falhou: ${erro}`);
      }
    }
    for (const ip of inc.ips.slice(MAX_IPS_BLOQUEIO)) {
      erros.set(ip, `acima do limite de ${MAX_IPS_BLOQUEIO} IPs por incidente`);
    }
    if (ids.length === 0) {
      await salvarDecisao(deps.sql, inc.id, dec, null, agora, { erro });
      const status = montarStatus(inc.ips, {
        erros,
        antes,
        barradas: cf.barradas,
        motivoNao: `falha ao bloquear: ${erro ?? "desconhecido"}`,
      });
      await deps.notificar("sugestao", {
        titulo: `⚠️ Falha ao bloquear (não bloqueado): ${tituloIps(inc.ips)}`,
        corpo: [
          ...linhasStatus(inc.ips, status),
          ...await locais(),
          resumoPush(dec, pareceres, "falha ao bloquear"),
          `${dec.motivo}. Erro: ${
            erro ?? "desconhecido"
          }. Bloqueie manualmente.`,
        ].join("\n"),
        url: `/incidentes/${inc.id}`,
        acoes: [{ acao: "investigar", titulo: "Investigar" }],
      });
      return dec;
    }
    await salvarDecisao(deps.sql, inc.id, dec, "bloqueado", agora, {
      bloqueioIds: ids,
      erro,
    });
    let info = new Map<number, InfoBloqueio>();
    try {
      info = await infoBloqueios(deps.sql, ids);
    } catch (e) {
      console.error(
        `scheduler: vencimento dos bloqueios: ${(e as Error).message}`,
      );
    }
    const fallbackAte = new Date(agora.getTime() + dias * 86_400_000);
    const bloqueados = new Map<string, Date | null>();
    for (const [ip, id] of idPorIp) {
      const i = info.get(id);
      bloqueados.set(ip, i ? i.expira : fallbackAte);
    }
    const status = montarStatus(inc.ips, {
      bloqueados,
      dias,
      regra: dec.regra ?? "reserva",
      erros,
      antes,
      barradas: cf.barradas,
      motivoNao: "não bloqueado",
    });
    const okIps = [...idPorIp.keys()];
    const q = ids.map((id) => `bloqueio=${id}`).join("&");
    await deps.notificar("bloqueio_auto", {
      titulo: `🔒 ${
        okIps.length === 1 ? "IP bloqueado" : `${okIps.length} IPs bloqueados`
      } ${rotuloDuracao(dias)}: ${tituloIps(okIps)}`,
      corpo: [
        ...linhasStatus(inc.ips, status),
        ...await locais(),
        resumoPush(dec, pareceres, `bloqueado ${duracaoTxt(dias)}`),
        dec.motivo,
      ].join("\n"),
      url: `/incidentes/${inc.id}?${q}`,
      acoes: [
        { acao: "desfazer", titulo: "Desfazer" },
        { acao: "investigar", titulo: "Investigar" },
      ],
    });
    return dec;
  }

  await salvarDecisao(deps.sql, inc.id, dec, null, agora);
  const status = montarStatus(inc.ips, {
    antes,
    barradas: cf.barradas,
    motivoNao,
  });
  const desfecho = dec.observacao
    ? `teria bloqueado ${duracaoTxt(dias)} (${
      autoAtivo ? "modo observação" : "bloqueio automático desligado"
    })`
    : "sugestão de bloqueio";
  await deps.notificar("sugestao", {
    titulo: `${prefixoSugestao([...status.values()], dec.observacao)}: ${
      tituloIps(inc.ips)
    }`,
    corpo: [
      ...linhasStatus(inc.ips, status),
      ...await locais(),
      resumoPush(dec, pareceres, desfecho),
      dec.motivo,
    ].join("\n"),
    url: `/incidentes/${inc.id}`,
    acoes: [{ acao: "investigar", titulo: "Investigar" }],
  });
  return dec;
}

/** Um ciclo completo. Sem lock (outro ciclo rodando) devolve {executado:false}. */
export async function ciclo(deps: CicloDeps): Promise<ResultadoCiclo> {
  const r = await comLockCiclo(deps.sql, () => cicloInterno(deps));
  return r.ok ? r.valor : { executado: false };
}

/** Máximo de verificações de bot (DNS reverso) por ciclo. */
export const MAX_CONSULTAS_BOT = 20;

/**
 * ehBotVerificado com cache por (ip, ua) e teto de MAX_CONSULTAS_BOT consultas
 * por ciclo; acima do teto devolve null (não verificado neste ciclo).
 */
function verificadorDoCiclo(deps: CicloDeps) {
  const cache = new Map<string, boolean>();
  let consultas = 0;
  return async (ip: string, ua: string): Promise<boolean | null> => {
    const k = `${ip}|${ua}`;
    const c = cache.get(k);
    if (c !== undefined) return c;
    if (consultas >= MAX_CONSULTAS_BOT) return null;
    consultas++;
    const r = await deps.ehBotVerificado(ip, ua);
    cache.set(k, r);
    return r;
  };
}

/**
 * IPs candidatos a "acesso estrangeiro que passou" verificados como bots
 * (no máx. MAX_CONSULTAS_BOT consultas por ciclo); os confirmados são gravados
 * em vigia.bots_verificados (usados também pelos selos das telas).
 */
async function botsEntreCandidatos(
  deps: CicloDeps,
  eventos: Evento[],
  ctx: CtxPassou,
  agora: Date,
  verificar: ReturnType<typeof verificadorDoCiclo>,
): Promise<Set<string>> {
  const bots = new Set<string>(
    (await deps.sql`SELECT host(ip) ip FROM vigia.bots_verificados`).map((r) =>
      String(r.ip)
    ),
  );
  const uas = new Map<string, Set<string>>();
  for (const e of eventos) {
    if (bots.has(e.ip) || !e.ua || !passouGeo(e, { ...ctx, bots })) continue;
    const u = uas.get(e.ip) ?? new Set<string>();
    u.add(e.ua);
    uas.set(e.ip, u);
  }
  for (const [ip, us] of uas) {
    for (const ua of us) {
      const r = await verificar(ip, ua);
      if (r === null) return bots; // teto do ciclo
      if (r) {
        bots.add(ip);
        await deps.sql`INSERT INTO vigia.bots_verificados (ip, visto_em)
          VALUES (${ip}::inet, ${agora})
          ON CONFLICT (ip) DO UPDATE SET visto_em = EXCLUDED.visto_em`;
        break;
      }
    }
  }
  return bots;
}

async function cicloInterno(deps: CicloDeps): Promise<ResultadoCiclo> {
  const { sql } = deps;
  try {
    await deps.coletar();
  } catch (e) {
    console.error(`scheduler: coleta falhou: ${(e as Error).message}`);
  }
  const agora = deps.agora();
  try {
    await verificarColetor(deps, agora);
  } catch (e) {
    console.error(`scheduler: verificar coletor: ${(e as Error).message}`);
  }

  const cfg = await lerConfigGeral(sql);
  const bloqueados = await ipsBloqueadosAtivos(sql, agora);
  const ativo = (ip: string) => !bloqueados.has(normalizarIp(ip));
  const carregados = await carregarEventos(sql, agora);
  const ultimoId = carregados.ultimoId;
  // IP do servidor do Vigia: protegido; a auditoria dele (UA Vigia-Auditoria)
  // não passa pelo detector, mas o resto do tráfego da rede de casa passa.
  const ipsServidor = new Set(await ipsServidorVigentes(sql, agora));
  const considerar = (e: Evento) =>
    ativo(e.ip) && !ehAuditoriaPropria(e, ipsServidor);
  // IP já bloqueado: o Cloudflare barra; nada a detectar/triar/notificar.
  const eventos = carregados.eventos.filter(considerar);
  const janela = carregados.janela.filter(considerar);
  const permitidos = await permitidosVigentes(sql, agora);
  const exc =
    await sql`SELECT valor FROM vigia.excecoes WHERE tipo = 'caminho'`;
  const verificarBot = verificadorDoCiclo(deps);
  const desdeCfg = cfg.get("geo_ativo_desde");
  const ctxPassou: CtxPassou = {
    geoAtivoDesde: flag(cfg, "geo_ativo") && typeof desdeCfg === "string"
      ? new Date(desdeCfg)
      : null,
    excecoes: exc.map((r) => String(r.valor)),
    vigiaHost: deps.vigiaHost ?? VIGIA_HOST_PADRAO,
    permitidos,
    bots: new Set(),
  };
  if (ctxPassou.geoAtivoDesde) {
    ctxPassou.bots = await botsEntreCandidatos(
      deps,
      eventos,
      ctxPassou,
      agora,
      verificarBot,
    );
  }
  const sinais = detectarComJanela(
    deps.detectar ?? detectarPadrao,
    eventos,
    janela,
    {
      excecoesCaminho: exc.map((r) => String(r.valor)),
      permitidos: new Set(permitidos),
      limiares: limiares(cfg),
      passou: ctxPassou,
      asnsDatacenter: new Set(await asnsDatacenterAtivos(sql)),
    },
  ).filter((s) => ativo(s.ip));

  await avisarConectores(deps, eventos, {
    vigiaHost: ctxPassou.vigiaHost,
    asnsDatacenter: new Set(await asnsDatacenterAtivos(sql)),
  });

  let persistidos: Incidente[] = [];
  let antes = new Map<number, Incidente>();
  let sinaisNovos = sinais;
  if (sinais.length > 0) {
    // IP de incidente ignorado/bloqueado nas últimas 24 h: só anexa.
    const enc = anexarEncerrados(
      sinais,
      await carregarEncerradosRecentes(sql, agora),
    );
    sinaisNovos = enc.restantes;
    if (enc.atualizados.length > 0) {
      await persistirIncidentes(sql, {
        novos: [],
        atualizados: enc.atualizados,
      });
    }
  }
  if (sinaisNovos.length > 0) {
    const abertos = await carregarAbertos(sql, agora);
    antes = new Map(abertos.map((i) => [i.id!, i]));
    persistidos = await persistirIncidentes(
      sql,
      agrupar(sinaisNovos, abertos),
    );
  }
  // Marca d'água só avança depois dos sinais persistidos.
  if (ultimoId !== null) {
    await gravarConfig(sql, "ciclo_ultimo_evento_id", ultimoId);
  }

  const triar = persistidos.filter((i) => precisaTriagem(i, antes));
  // Adiados em ciclos anteriores (limite da triagem) voltam agora.
  const ids = new Set(triar.map((i) => i.id));
  for (const p of await carregarPendentes(sql)) {
    if (!ids.has(p.id)) triar.push(p);
  }
  const decisoes: ResultadoCiclo["decisoes"] = [];
  const adiadasCiclo = new Set<string>();
  if (triar.length > 0) {
    // Pendentes ANTES da triagem: se o ciclo cair no meio, voltam no próximo.
    // A decisão (salvarDecisao) limpa; os adiados continuam pendentes.
    await sql`UPDATE vigia.incidentes SET triagem_pendente = true
      WHERE id = ANY(${triar.map((i) => i.id!)}::bigint[])`;
    const { anomalias, pareceres, adiados = [] } = await deps.triar(
      triar,
      eventos,
    );
    const adiadas = adiadasCiclo;
    for (const a of adiados) adiadas.add(a);

    await avisarAnomalias(
      deps,
      anomalias,
      new Set([
        ...eventos.map((e) => e.host),
        ...triar.flatMap((i) => i.hosts),
      ]),
    );

    // UA vista no ciclo por IP (para verificar buscadores alegados).
    const uas = new Map<string, Set<string>>();
    for (const e of eventos) {
      if (!e.ua) continue;
      const s = uas.get(e.ip) ?? new Set<string>();
      s.add(e.ua);
      uas.set(e.ip, s);
    }
    const ctxBase = {
      permitidos: new Set(permitidos),
      // IP do servidor do Vigia: protegido como o do administrador.
      ipsAdmin: new Set([
        ...await ipsAdminVigentes(sql, agora),
        ...ipsServidor,
      ]),
      ipsCloudflare: CLOUDFLARE_IPS_PADRAO,
      modoObservacao: emObservacao(cfg, agora),
      jevLimiar: configDecisao(cfg).jevLimiar,
      jevExigeSegunda: configDecisao(cfg).jevExigeSegunda,
    };
    const autoAtivo = flag(cfg, "bloqueio_auto_ativo");

    for (const inc of triar) {
      if (adiadas.has(inc.chave)) continue; // sem decisão nem push neste ciclo
      const id = inc.id!;
      try {
        const ps = pareceres.get(inc.chave) ?? [];
        await salvarPareceres(sql, id, ps);
        const bots = new Set<string>();
        for (const ip of inc.ips) {
          for (const ua of uas.get(ip) ?? []) {
            if (await verificarBot(ip, ua)) {
              bots.add(ip);
              break;
            }
          }
        }
        const d = decidir(inc, ps, {
          ...ctxBase,
          ehBotVerificado: (ip) => bots.has(ip),
        });
        const final = await executarDecisao(
          deps,
          { ...inc, id },
          d,
          autoAtivo,
          agora,
          ps,
          cfg.get("modo_observacao_ate"),
        );
        decisoes.push({ incidenteId: id, acao: final.acao });
      } catch (e) {
        console.error(
          `scheduler: decisão do incidente ${id} falhou: ${
            (e as Error).message
          }`,
        );
      }
    }
  }

  if (triar.length === 0 && eventos.length > 0) {
    try {
      if (
        await reservarJanela(sql, "jev_ultimo_monitor", JEV_MONITOR_MIN, agora)
      ) {
        await avisarAnomalias(
          deps,
          await deps.monitorar(eventos),
          new Set(eventos.map((e) => e.host)),
        );
      }
    } catch (e) {
      console.error(`scheduler: monitor do Jev: ${(e as Error).message}`);
    }
  }

  // Só agora (após triagem e decisões) o agregado de estrangeiros.
  try {
    const semTriagem = new Set<string>();
    for (const i of triar) {
      if (adiadasCiclo.has(i.chave)) {
        for (const ip of i.ips) semTriagem.add(normalizarIp(ip));
      }
    }
    await avisarEstrangeiros(deps, eventos, ctxPassou, semTriagem);
  } catch (e) {
    console.error(`scheduler: aviso estrangeiro: ${(e as Error).message}`);
  }

  // Horário de FIM do ciclo (não o de início, capturado em `agora`).
  await gravarConfig(sql, "ciclo_ultimo_ok", deps.agora().toISOString());
  return {
    executado: true,
    eventos: eventos.length,
    sinais: sinais.length,
    incidentes: persistidos.length,
    decisoes,
  };
}

// ------------------------------------------------------------------ jobs

export interface JobHoraDeps {
  sql: Sql;
  agora: () => Date;
  /** Reaplica a regra geo com o estado atual e grava geo_aplicado_em. */
  reaplicarGeo: () => Promise<unknown>;
  expirarVencidos: () => Promise<number>;
  /** Re-sincroniza zonas e garante lista/regras do Vigia (cf_zone_ids com falha). */
  garantirInfra?: () => Promise<{ zonasComFalha: string[] }>;
  notificar: CicloDeps["notificar"];
  /** Redescobre o IP público do servidor do Vigia (trace do Cloudflare). */
  descobrirIpServidor?: () => Promise<unknown>;
}

/**
 * Job horário: (1) se algum permitido expirou depois da última aplicação da
 * regra geo, reaplica; (2) expira bloqueios vencidos com um aviso agregado.
 */
export async function jobHora(deps: JobHoraDeps): Promise<{ geo: boolean }> {
  let geo = false;
  try {
    geo = await reaplicarSePermitidoExpirou(deps);
  } catch (e) {
    console.error(`scheduler: reaplicar geo: ${(e as Error).message}`);
  }
  try {
    await expirarBloqueios(deps);
  } catch (e) {
    console.error(`scheduler: expirar bloqueios: ${(e as Error).message}`);
  }
  try {
    await verificarInfra(deps);
  } catch (e) {
    console.error(`scheduler: garantir infra: ${(e as Error).message}`);
  }
  try {
    await deps.descobrirIpServidor?.();
  } catch (e) {
    console.error(`scheduler: IP do servidor: ${(e as Error).message}`);
  }
  return { geo };
}

async function verificarInfra(deps: JobHoraDeps) {
  if (!deps.garantirInfra) return;
  const { zonasComFalha } = await deps.garantirInfra();
  if (zonasComFalha.length === 0) return;
  if (!await reservarAviso(deps.sql, "infra_zonas", 24 * 60, deps.agora())) {
    return;
  }
  const rows = await deps.sql`SELECT cf_zone_id, nome FROM vigia.zonas
    WHERE cf_zone_id = ANY(${zonasComFalha}::text[])`;
  const nomes = new Map(
    rows.map((r) => [String(r.cf_zone_id), String(r.nome)]),
  );
  const lista = zonasComFalha.map((z) => nomes.get(z) ?? z);
  await deps.notificar("coletor_parado", {
    titulo: `Regra não criada em ${lista.length} zona(s)`,
    corpo: `O Vigia não conseguiu criar/atualizar a regra de bloqueio em: ${
      resumirIps(lista)
    }. Verifique o limite de 5 regras por zona do plano Free.`,
    url: "/config",
    chaveAgregacao: "infra",
  });
}

async function reaplicarSePermitidoExpirou(deps: JobHoraDeps) {
  const agora = deps.agora();
  const [g] = await deps.sql`SELECT valor FROM vigia.config_geral
    WHERE chave = 'geo_aplicado_em'`;
  const desde = typeof g?.valor === "string" ? new Date(g.valor) : new Date(0);
  const [x] = await deps.sql`SELECT 1 FROM vigia.permitidos
    WHERE expira IS NOT NULL AND expira <= ${agora} AND expira > ${desde}
    LIMIT 1`;
  if (!x) return false;
  await deps.reaplicarGeo();
  return true;
}

async function expirarBloqueios(deps: JobHoraDeps) {
  const { sql } = deps;
  const agora = deps.agora();
  const venc = await sql`SELECT id FROM vigia.bloqueios
    WHERE removido IS NULL AND expira IS NOT NULL AND expira <= ${agora}
    ORDER BY id`;
  if (venc.length === 0) return;
  await deps.expirarVencidos();
  const ids = venc.map((v) => Number(v.id));
  const feitos = await sql`SELECT host(ip) ip FROM vigia.bloqueios
    WHERE id = ANY(${ids}::bigint[]) AND removido IS NOT NULL ORDER BY id`;
  if (feitos.length > 0) {
    const lista = feitos.map((r) => String(r.ip));
    await deps.notificar("bloqueio_expirado", {
      titulo: `${lista.length} bloqueio(s) expirado(s)`,
      corpo: `Removidos do Cloudflare: ${resumirIps(lista)}`,
      url: "/bloqueios",
      chaveAgregacao: "expirados",
    });
  }
  // Ainda vencidos e ativos após as tentativas: a remoção falhou.
  const falhos = await sql`SELECT host(ip) ip FROM vigia.bloqueios
    WHERE id = ANY(${ids}::bigint[]) AND removido IS NULL
      AND expira <= ${agora} ORDER BY id`;
  if (falhos.length === 0) return;
  if (!await reservarAviso(sql, "expirar_falhou", 360, agora)) return;
  const lista = falhos.map((r) => String(r.ip));
  await deps.notificar("bloqueio_expirado", {
    titulo: `Falha ao remover bloqueio de ${resumirIps(lista)}`,
    corpo:
      "O Cloudflare não confirmou a remoção; o Vigia tenta de novo a cada hora. Remova manualmente em Bloqueios se persistir.",
    url: "/bloqueios",
    chaveAgregacao: "expirar_falhou",
  });
}

function resumirIps(lista: string[]): string {
  return lista.slice(0, 10).join(", ") +
    (lista.length > 10 ? ` e mais ${lista.length - 10}` : "");
}

export interface JobDiarioDeps {
  sql: Sql;
  agora: () => Date;
}

/** Job diário: retenção de 30 dias em vigia.eventos. */
export async function jobDiario(deps: JobDiarioDeps): Promise<void> {
  try {
    const limite = new Date(
      deps.agora().getTime() - RETENCAO_DIAS * 86_400_000,
    );
    await deps.sql`DELETE FROM vigia.eventos WHERE ts < ${limite}`;
  } catch (e) {
    console.error(`scheduler: limpeza de eventos: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ timers

export interface SchedulerDeps {
  ciclo: CicloDeps;
  hora: JobHoraDeps;
  diario: JobDiarioDeps;
  /** Auditoria de configuração dos sites (06:00 em São Paulo, 1x/dia). */
  auditoria?: JobAuditoriaDeps;
  /** Monitor dos apps do EasyPanel (a cada 2 min), se configurado. */
  easypanel?: () => Promise<unknown>;
  /** Alertas do próprio servidor (temperatura, memória, carga, disco), a cada 2 min. */
  servidor?: () => Promise<unknown>;
  intervaloMs?: number;
}

export interface TarefaAgendada {
  nome: string;
  intervaloMs: number;
  fn: () => Promise<unknown>;
}

/** Tarefas periódicas do Vigia (nome, intervalo, função). */
export function tarefasAgendadas(deps: SchedulerDeps): TarefaAgendada[] {
  const t: TarefaAgendada[] = [
    {
      nome: "ciclo",
      intervaloMs: deps.intervaloMs ?? 60_000,
      fn: () => ciclo(deps.ciclo),
    },
    {
      nome: "job horário",
      intervaloMs: 3_600_000,
      fn: () => jobHora(deps.hora),
    },
    {
      nome: "job diário",
      intervaloMs: 86_400_000,
      fn: () => jobDiario(deps.diario),
    },
  ];
  const aud = deps.auditoria;
  if (aud) {
    t.push({
      nome: "auditoria",
      intervaloMs: 5 * 60_000,
      fn: () => jobAuditoria(aud),
    });
  }
  if (deps.easypanel) {
    t.push({
      nome: "easypanel",
      intervaloMs: 2 * 60_000,
      fn: deps.easypanel,
    });
  }
  if (deps.servidor) {
    t.push({
      nome: "servidor",
      intervaloMs: 2 * 60_000,
      fn: deps.servidor,
    });
  }
  return t;
}

/** Inicia os timers; erros só são registrados. Devolve uma função de parada. */
export function iniciarScheduler(deps: SchedulerDeps): () => void {
  const seguro = (nome: string, fn: () => Promise<unknown>) => {
    let rodando = false;
    return async () => {
      if (rodando) return;
      rodando = true;
      try {
        await fn();
      } catch (e) {
        console.error(`scheduler: ${nome} falhou:`, e);
      } finally {
        rodando = false;
      }
    };
  };
  const tarefas = tarefasAgendadas(deps).map((t) => ({
    ...t,
    fn: seguro(t.nome, t.fn),
  }));
  const timers = tarefas.map((t) => setInterval(t.fn, t.intervaloMs));
  const inicio = setTimeout(() => tarefas.forEach((t) => t.fn()), 1_000);
  return () => {
    clearTimeout(inicio);
    timers.forEach(clearInterval);
  };
}
