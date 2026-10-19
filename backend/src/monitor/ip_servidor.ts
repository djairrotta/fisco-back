// IP público de saída do servidor do Vigia (rede de casa, dinâmico). É
// descoberto pelo trace do Cloudflare antes de cada auditoria e a cada hora,
// e fica protegido como o IP do administrador: nunca é bloqueado, e a
// auditoria do próprio Vigia vinda dele não passa pelo detector.
import type { Sql } from "../db/client.ts";
import { ipValido } from "./decision.ts";
import { normalizarIp } from "./grouper.ts";

export const URL_TRACE = "https://cloudflare.com/cdn-cgi/trace";
export const ROTULO_IP_SERVIDOR = "servidor do Vigia (automático)";
/** UA da auditoria (o mesmo de src/auditoria/verificacoes.ts). */
export const PREFIXO_UA_AUDITORIA = "Vigia-Auditoria/";
const CHAVE = "ip_servidor";
const JANELA_MS = 7 * 86_400_000;
const MAX_IPS = 3;

interface Visto {
  ip: string;
  vistoEm: string;
}
interface ValorIpServidor extends Visto {
  historico: Visto[];
}

/** IP da linha `ip=` do trace; null se ausente ou inválido. */
export function ipDoTrace(texto: string): string | null {
  const m = /^ip=([0-9a-fA-F:.]{2,45})\s*$/m.exec(texto);
  return m && ipValido(m[1]) ? m[1] : null;
}

export interface DescobrirDeps {
  sql: Sql;
  agora: () => Date;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** GET no trace do Cloudflare; grava e devolve o IP (null em falha). */
export async function descobrirIpServidor(
  d: DescobrirDeps,
): Promise<string | null> {
  const f = d.fetch ?? ((u, i) => fetch(u, i));
  let ip: string | null = null;
  try {
    const r = await f(URL_TRACE, {
      method: "GET",
      headers: {
        "User-Agent": "Vigia-Auditoria/1.0 (+https://vigia.judinfo.com.br)",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    ip = ipDoTrace((await r.text()).slice(0, 4096));
  } catch (e) {
    console.error(`ip_servidor: trace falhou: ${(e as Error)?.message ?? e}`);
    return null;
  }
  if (!ip) return null;
  ip = normalizarIp(ip);
  const agora = d.agora();
  await d.sql.begin(async (tx) => {
    const [a] = await tx`SELECT valor FROM vigia.config_geral
      WHERE chave = ${CHAVE} FOR UPDATE`;
    const ant = (a?.valor as ValorIpServidor | undefined)?.historico ?? [];
    const historico = [
      { ip: ip!, vistoEm: agora.toISOString() },
      ...ant.filter((h) => h.ip !== ip),
    ]
      .filter((h) =>
        agora.getTime() - new Date(h.vistoEm).getTime() <= JANELA_MS
      )
      .sort((x, y) => y.vistoEm.localeCompare(x.vistoEm))
      .slice(0, MAX_IPS);
    const valor: ValorIpServidor = {
      ip: ip!,
      vistoEm: agora.toISOString(),
      historico,
    };
    await tx`INSERT INTO vigia.config_geral (chave, valor)
      VALUES (${CHAVE}, ${tx.json(valor as never)})
      ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
  });
  return ip;
}

async function vigentes(sql: Sql, agora: Date): Promise<Visto[]> {
  const [a] = await sql`SELECT valor FROM vigia.config_geral
    WHERE chave = ${CHAVE}`;
  const h = (a?.valor as ValorIpServidor | undefined)?.historico ?? [];
  return h.filter((x) =>
    typeof x?.ip === "string" && ipValido(x.ip) &&
    agora.getTime() - new Date(x.vistoEm).getTime() <= JANELA_MS
  );
}

/** IPs do servidor vistos nos últimos 7 dias (no máximo 3). */
export async function ipsServidorVigentes(
  sql: Sql,
  agora: Date,
): Promise<string[]> {
  return (await vigentes(sql, agora)).map((x) => x.ip);
}

/** Para Regras/listar_regras: IP, quando foi visto e o rótulo. */
export async function listarIpsServidor(sql: Sql, agora: Date) {
  return (await vigentes(sql, agora)).map((x) => ({
    ip: x.ip,
    vistoEm: x.vistoEm,
    rotulo: ROTULO_IP_SERVIDOR,
  }));
}

/** Requisição da própria auditoria (UA do Vigia vindo do IP do servidor). */
export function ehAuditoriaPropria(
  e: { ip: string; ua?: string | null },
  ipsServidor: Set<string>,
): boolean {
  return (e.ua ?? "").startsWith(PREFIXO_UA_AUDITORIA) &&
    ipsServidor.has(normalizarIp(e.ip));
}
