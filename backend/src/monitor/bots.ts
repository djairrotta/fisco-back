import { normalizarIp } from "./grouper.ts";

/**
 * Buscadores verificáveis por DNS reverso + confirmação direta. DuckDuckBot
 * não publica PTR verificável (só lista de IPs): fica como não verificado.
 */
const UA_BUSCADOR = /googlebot|google-inspectiontool|bingbot|applebot/i;
const SUFIXOS = [
  "googlebot.com",
  "google.com",
  "search.msn.com",
  "applebot.apple.com",
];
const TTL_MS = 24 * 3_600_000;
const TTL_ERRO_MS = 3_600_000;
const MAX_CACHE = 10_000;

export type Resolver = (
  query: string,
  tipo: "PTR" | "A" | "AAAA",
) => Promise<string[]>;

const resolverPadrao: Resolver = (q, t) =>
  Deno.resolveDns(q, t) as Promise<string[]>;

function expandirV6(ip: string): string[] | null {
  const [a, b, ...resto] = ip.split("::");
  if (resto.length) return null;
  const head = a ? a.split(":") : [];
  const tail = b !== undefined && b ? b.split(":") : [];
  const falta = 8 - head.length - tail.length;
  if (b === undefined ? falta !== 0 : falta < 1) return null;
  const g = [...head, ...Array(b === undefined ? 0 : falta).fill("0"), ...tail];
  if (!g.every((x) => /^[0-9a-f]{1,4}$/i.test(x))) return null;
  return g.map((x) => x.toLowerCase().padStart(4, "0"));
}

/** Nome para consulta PTR (in-addr.arpa / ip6.arpa); null se inválido. */
export function nomeReverso(ip: string): string | null {
  if (ip.includes(":")) {
    const g = expandirV6(ip);
    if (!g) return null;
    return g.join("").split("").reverse().join(".") + ".ip6.arpa";
  }
  const p = ip.split(".");
  if (p.length !== 4 || !p.every((x) => /^\d{1,3}$/.test(x) && +x <= 255)) {
    return null;
  }
  return [...p].reverse().join(".") + ".in-addr.arpa";
}

const semPonto = (h: string) => h.replace(/\.$/, "").toLowerCase();
const noDominio = (h: string) =>
  SUFIXOS.some((s) => h === s || h.endsWith("." + s));

/**
 * Verificador de buscador: a UA alega ser um buscador conhecido E o PTR do IP
 * está no domínio do buscador E esse nome resolve de volta para o IP.
 * Resultado do DNS fica em cache por IP (24 h; erro: 1 h). Erros → false.
 */
export function criarVerificadorBots(
  opts: { resolver?: Resolver; agora?: () => number } = {},
): (ip: string, ua: string) => Promise<boolean> {
  const resolver = opts.resolver ?? resolverPadrao;
  const agora = opts.agora ?? Date.now;
  const cache = new Map<string, { ok: boolean; exp: number }>();

  async function verificarDns(ip: string): Promise<boolean> {
    const rev = nomeReverso(ip);
    if (!rev) return false;
    const alvo = normalizarIp(ip).toLowerCase();
    const v6 = ip.includes(":");
    const nomes = (await resolver(rev, "PTR")).map(semPonto).filter(noDominio);
    for (const nome of nomes.slice(0, 5)) {
      let ips: string[] = [];
      try {
        ips = await resolver(nome, v6 ? "AAAA" : "A");
      } catch {
        continue;
      }
      if (ips.some((x) => normalizarIp(x).toLowerCase() === alvo)) return true;
    }
    return false;
  }

  return async (ip, ua) => {
    if (!UA_BUSCADOR.test(ua ?? "")) return false;
    const t = agora();
    const c = cache.get(ip);
    if (c && c.exp > t) return c.ok;
    let ok = false;
    let ttl = TTL_MS;
    try {
      ok = await verificarDns(ip);
    } catch {
      ok = false;
      ttl = TTL_ERRO_MS;
    }
    if (cache.size >= MAX_CACHE) {
      for (const [k, v] of cache) if (v.exp <= t) cache.delete(k);
      if (cache.size >= MAX_CACHE) {
        cache.delete(cache.keys().next().value as string);
      }
    }
    cache.set(ip, { ok, exp: t + ttl });
    return ok;
  };
}
