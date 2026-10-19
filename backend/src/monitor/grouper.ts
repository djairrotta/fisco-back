import type { Sql } from "../db/client.ts";
import type { Incidente, Severidade, Sinal } from "./types.ts";

const ORDEM: Record<Severidade, number> = { baixa: 0, media: 1, alta: 2 };
const maxSev = (a: Severidade, b: Severidade): Severidade =>
  ORDEM[b] > ORDEM[a] ? b : a;

export const MAX_SINAIS = 50;

/** Forma canônica do IP (IPv6 comprimido e minúsculo); IPv4 e inválidos ficam como estão. */
export function normalizarIp(ip: string): string {
  const t = ip.trim();
  if (!t.includes(":")) return t;
  try {
    return new URL(`http://[${t}]`).hostname.slice(1, -1);
  } catch {
    return t;
  }
}

const ehV4 = (ip: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
const prefixo24 = (ip: string) => ip.split(".").slice(0, 3).join(".");

function uniao<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}

function asnsDe(inc: Incidente): Set<number> {
  const s = new Set<number>();
  for (const x of inc.sinais) if (x.asn && x.asn > 0) s.add(x.asn);
  return s;
}

/** Como o sinal se relaciona ao incidente: ip exato, /24, asn ou nada. */
function casamento(
  inc: Incidente,
  s: Sinal,
): "ip" | "24" | "asn" | null {
  if (inc.ips.includes(s.ip)) return "ip";
  if (
    ehV4(s.ip) &&
    inc.ips.some((i) => ehV4(i) && prefixo24(i) === prefixo24(s.ip))
  ) {
    return "24";
  }
  if (s.asn && s.asn > 0 && asnsDe(inc).has(s.asn)) return "asn";
  return null;
}

function chaveDe(inc: Incidente): string {
  if (inc.ips.length === 1) return inc.ips[0];
  if (
    inc.ips.every((i) => ehV4(i)) && new Set(inc.ips.map(prefixo24)).size === 1
  ) {
    return `/24:${prefixo24(inc.ips[0])}`;
  }
  const asns = asnsDe(inc);
  // ASN comum a todos os sinais
  for (const a of asns) {
    if (
      inc.ips.every((ip) => inc.sinais.some((x) => x.ip === ip && x.asn === a))
    ) {
      return `asn:${a}`;
    }
  }
  return `misto:${inc.ips[0]}`;
}

function clonar(i: Incidente): Incidente {
  return {
    ...i,
    ips: i.ips.map(normalizarIp),
    zonaIds: [...i.zonaIds],
    hosts: [...i.hosts],
    sinais: [...i.sinais],
    inicio: new Date(i.inicio),
    fim: new Date(i.fim),
  };
}

export function agrupar(
  sinais: Sinal[],
  abertos: Incidente[],
  janelaMin = 15,
): { novos: Incidente[]; atualizados: Incidente[] } {
  const janela = janelaMin * 60_000;
  const trabalho = abertos.map((i) => ({
    inc: clonar(i),
    novo: false,
    tocado: false,
  }));
  const ordenados = [...sinais].sort((a, b) => a.ts.getTime() - b.ts.getTime());

  for (let s of ordenados) {
    s = { ...s, ip: normalizarIp(s.ip) };
    const t = s.ts.getTime();
    let melhor: (typeof trabalho)[number] | null = null;
    let melhorRank = 99;
    for (const w of trabalho) {
      if (t - w.inc.fim.getTime() > janela) continue;
      if (w.inc.inicio.getTime() - t > janela) continue;
      const m = casamento(w.inc, s);
      if (!m) continue;
      const rank = m === "ip" ? 0 : m === "24" ? 1 : 2;
      if (rank < melhorRank) {
        melhor = w;
        melhorRank = rank;
      }
    }
    if (!melhor) {
      melhor = {
        inc: {
          chave: s.ip,
          ips: [],
          zonaIds: [],
          hosts: [],
          inicio: s.ts,
          fim: s.ts,
          sinais: [],
          severidadeMax: s.severidade,
          totalSinais: 0,
          contagemTotal: 0,
        },
        novo: true,
        tocado: true,
      };
      trabalho.push(melhor);
    }
    const inc = melhor.inc;
    melhor.tocado = true;
    inc.ips = uniao(inc.ips, [s.ip]);
    inc.zonaIds = uniao(inc.zonaIds, [s.zonaId]);
    inc.hosts = uniao(inc.hosts, [s.host]);
    inc.sinais.push(s);
    if (inc.sinais.length > MAX_SINAIS) {
      inc.sinais = inc.sinais.slice(-MAX_SINAIS);
    }
    inc.totalSinais += 1;
    inc.contagemTotal += s.contagem;
    if (s.ts < inc.inicio) inc.inicio = s.ts;
    if (s.ts > inc.fim) inc.fim = s.ts;
    inc.severidadeMax = maxSev(inc.severidadeMax, s.severidade);
    inc.chave = chaveDe(inc);
  }

  return {
    novos: trabalho.filter((w) => w.novo).map((w) => w.inc),
    atualizados: trabalho.filter((w) => !w.novo && w.tocado).map((w) => w.inc),
  };
}

const sinaisJson = (ss: Sinal[]) =>
  ss.map((s) => ({ ...s, ts: s.ts.toISOString() }));

export async function persistirIncidentes(
  sql: Sql,
  r: { novos: Incidente[]; atualizados: Incidente[] },
): Promise<Incidente[]> {
  for (const i of r.atualizados) {
    if (i.id === undefined) {
      throw new Error(`incidente atualizado sem id (chave ${i.chave})`);
    }
  }
  return await sql.begin(async (tx) => {
    const out: Incidente[] = [];
    for (const i of r.novos) {
      const [row] = await tx`
        INSERT INTO vigia.incidentes (chave, ips, zonas, hosts, inicio, fim, sinais,
          severidade_max, total_sinais, contagem_total)
        VALUES (${i.chave}, ${tx.array(i.ips)}::inet[], ${
        tx.array(i.zonaIds)
      }::int[],
          ${tx.array(i.hosts)}::text[], ${i.inicio}, ${i.fim},
          ${
        tx.json(sinaisJson(i.sinais) as never)
      }, ${i.severidadeMax}, ${i.totalSinais},
          ${i.contagemTotal})
        RETURNING id`;
      out.push({ ...i, id: Number(row.id) });
    }
    for (const i of r.atualizados) {
      await tx`
        UPDATE vigia.incidentes SET
          chave = ${i.chave},
          ips = ${tx.array(i.ips)}::inet[],
          zonas = ${tx.array(i.zonaIds)}::int[],
          hosts = ${tx.array(i.hosts)}::text[],
          inicio = ${i.inicio},
          fim = ${i.fim},
          sinais = ${tx.json(sinaisJson(i.sinais) as never)},
          severidade_max = ${i.severidadeMax},
          total_sinais = ${i.totalSinais},
          contagem_total = ${i.contagemTotal}
        WHERE id = ${i.id!}`;
      out.push(i);
    }
    return out;
  });
}

export async function carregarAbertos(
  sql: Sql,
  agora: Date,
  janelaMin = 15,
): Promise<Incidente[]> {
  const desde = new Date(agora.getTime() - janelaMin * 60_000);
  const rows = await sql`
    SELECT id, chave, inicio, fim, sinais, severidade_max, total_sinais, contagem_total, zonas, hosts,
      ARRAY(SELECT host(x) FROM unnest(ips) x) AS ips
    FROM vigia.incidentes
    WHERE status = 'aberto' AND fim >= ${desde}
    ORDER BY id`;
  return rows.map(linhaParaIncidente);
}

/** Incidentes abertos cuja triagem foi adiada (limite por ciclo), mais antigos primeiro. */
export async function carregarPendentes(
  sql: Sql,
  limite = 200,
): Promise<Incidente[]> {
  const rows = await sql`
    SELECT id, chave, inicio, fim, sinais, severidade_max, total_sinais, contagem_total, zonas, hosts,
      ARRAY(SELECT host(x) FROM unnest(ips) x) AS ips
    FROM vigia.incidentes
    WHERE triagem_pendente AND status = 'aberto'
    ORDER BY inicio, id LIMIT ${limite}`;
  return rows.map(linhaParaIncidente);
}

/** Incidentes já decididos pelo usuário/IA (ignorado ou bloqueado) com atividade recente. */
export async function carregarEncerradosRecentes(
  sql: Sql,
  agora: Date,
  horas = 24,
): Promise<Incidente[]> {
  const desde = new Date(agora.getTime() - horas * 3_600_000);
  const rows = await sql`
    SELECT id, chave, inicio, fim, sinais, severidade_max, total_sinais, contagem_total, zonas, hosts,
      ARRAY(SELECT host(x) FROM unnest(ips) x) AS ips
    FROM vigia.incidentes
    WHERE status IN ('ignorado', 'bloqueado') AND fim >= ${desde}
    ORDER BY id`;
  return rows.map(linhaParaIncidente);
}

/**
 * Sinais de IPs cujo incidente já foi ignorado/bloqueado são anexados a ele
 * (fim/contagens), sem passar de novo pela triagem. Devolve os demais sinais.
 */
export function anexarEncerrados(
  sinais: Sinal[],
  encerrados: Incidente[],
): { restantes: Sinal[]; atualizados: Incidente[] } {
  const porIp = new Map<string, Incidente>();
  // o mais recente (maior id) vence
  for (const i of [...encerrados].sort((a, b) => a.id! - b.id!)) {
    const c = clonar(i);
    for (const ip of c.ips) porIp.set(ip, c);
  }
  const tocados = new Set<Incidente>();
  const restantes: Sinal[] = [];
  for (const s0 of sinais) {
    const s = { ...s0, ip: normalizarIp(s0.ip) };
    const inc = porIp.get(s.ip);
    if (!inc) {
      restantes.push(s0);
      continue;
    }
    tocados.add(inc);
    inc.sinais.push(s);
    if (inc.sinais.length > MAX_SINAIS) {
      inc.sinais = inc.sinais.slice(-MAX_SINAIS);
    }
    inc.totalSinais += 1;
    inc.contagemTotal += s.contagem;
    if (s.ts > inc.fim) inc.fim = s.ts;
    if (s.ts < inc.inicio) inc.inicio = s.ts;
    inc.hosts = uniao(inc.hosts, [s.host]);
    inc.zonaIds = uniao(inc.zonaIds, [s.zonaId]);
  }
  return { restantes, atualizados: [...tocados] };
}

// deno-lint-ignore no-explicit-any
function linhaParaIncidente(r: any): Incidente {
  return {
    id: Number(r.id),
    chave: r.chave,
    ips: [...r.ips] as string[],
    zonaIds: [...r.zonas] as number[],
    hosts: [...r.hosts] as string[],
    inicio: new Date(r.inicio),
    fim: new Date(r.fim),
    severidadeMax: r.severidade_max,
    totalSinais: Number(r.total_sinais),
    contagemTotal: Number(r.contagem_total),
    sinais: (typeof r.sinais === "string" ? JSON.parse(r.sinais) : r.sinais)
      .map((s: Sinal & { ts: string }) => ({ ...s, ts: new Date(s.ts) })),
  };
}
