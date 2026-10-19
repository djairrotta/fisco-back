// Vendedores de conector cujas faixas de egress MUDAM e por isso são buscadas no
// provedor (a própria doc da OpenAI manda "buscar o arquivo regularmente"). O
// Vigia (rodando no VPS, com rede) faz essa busca e guarda em vigia.conector_faixas.
// A faixa da Anthropic é estável e fica embutida em geoblock.ts (FAIXA_CONECTOR_PADRAO).
import { isIP } from "node:net";
import type { Sql } from "../db/client.ts";

export interface VendorConector {
  nome: string;
  url: string;
}

/**
 * Fontes oficiais de egress de conector. OpenAI publica dois arquivos.
 * Google publica as faixas de "user-triggered-*" (ação feita a pedido do
 * usuário, ex.: Google-Agent/Gemini buscando/agindo numa página) — não as de
 * crawler comum (Googlebot) nem as de special-crawler (AdsBot), que não têm a
 * ver com "o usuário pediu pro Google acessar isso agora".
 */
export const VENDORES_CONECTOR: VendorConector[] = [
  { nome: "openai-codex", url: "https://openai.com/chatgpt-agents.json" },
  { nome: "openai-connectors", url: "https://openai.com/chatgpt-connectors.json" },
  {
    nome: "google-user-triggered-agents",
    url: "https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json",
  },
  {
    nome: "google-user-triggered-fetchers",
    url: "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json",
  },
  {
    nome: "google-user-triggered-fetchers-google",
    url: "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json",
  },
];

const VENDOR_TIMEOUT_MS = 10_000;
const MAX_FAIXAS_VENDOR = 4000;

/** Aceita IPv4/IPv6/CIDR; rejeita prefixos absurdamente amplos. */
export function cidrValido(s: string): boolean {
  if (typeof s !== "string" || s !== s.trim() || s === "") return false;
  const [ip, pfx, ...resto] = s.split("/");
  if (resto.length || ip.includes("%")) return false;
  const v = isIP(ip);
  if (!v) return false;
  if (pfx === undefined) return true;
  if (!/^\d{1,3}$/.test(pfx)) return false;
  const n = Number(pfx);
  return v === 4 ? n >= 8 && n <= 32 : n >= 16 && n <= 128;
}

/**
 * Extrai CIDRs de formatos comuns de arquivo de egress, de forma tolerante:
 * `{prefixes:[{ipv4Prefix|ipv6Prefix|ip_prefix}]}` (estilo Google/OpenAI), arrays
 * de string, ou campos cidrs/addresses/ranges. Ignora o que não for CIDR válido.
 */
export function parsearPrefixos(doc: unknown): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && cidrValido(v.trim())) out.add(v.trim());
  };
  const visitar = (x: unknown, prof: number) => {
    if (!x || prof > 6) return;
    if (typeof x === "string") return add(x);
    if (Array.isArray(x)) {
      for (const it of x) visitar(it, prof + 1);
      return;
    }
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      for (
        const k of ["ipv4Prefix", "ipv6Prefix", "ip_prefix", "ipPrefix", "cidr", "prefix"]
      ) {
        if (typeof o[k] === "string") add(o[k]);
      }
      for (const k of ["prefixes", "cidrs", "addresses", "ranges", "data", "entries"]) {
        if (k in o) visitar(o[k], prof + 1);
      }
    }
  };
  visitar(doc, 0);
  return [...out].slice(0, MAX_FAIXAS_VENDOR);
}

/**
 * Busca cada vendedor e grava suas faixas em vigia.conector_faixas (modo='vendor').
 * Nunca lança: falha de um vendedor é registrada e os demais seguem. Uma falha de
 * rede NÃO apaga as faixas já guardadas desse vendedor (não derruba conectores no ar).
 * Nunca sobrescreve uma decisão do usuário (permanente/temporario) da mesma faixa.
 */
export async function atualizarVendores(
  sql: Sql,
  fetchFn: typeof fetch = fetch,
): Promise<{ vendor: string; faixas: number; erro?: string }[]> {
  const res: { vendor: string; faixas: number; erro?: string }[] = [];
  for (const v of VENDORES_CONECTOR) {
    try {
      const r = await fetchFn(v.url, {
        signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!r.ok) {
        await r.body?.cancel?.();
        throw new Error(`HTTP ${r.status}`);
      }
      const doc = await r.json();
      const faixas = parsearPrefixos(doc);
      if (faixas.length === 0) throw new Error("nenhum CIDR válido no JSON");
      await sql.begin(async (tx) => {
        // Troca atômica: remove as faixas antigas DESTE vendedor e põe as novas.
        await tx`DELETE FROM vigia.conector_faixas
          WHERE modo = 'vendor' AND origem = ${v.nome}`;
        for (const f of faixas) {
          await tx`INSERT INTO vigia.conector_faixas (faixa, modo, origem)
            VALUES (${f}, 'vendor', ${v.nome})
            ON CONFLICT (faixa) DO UPDATE SET origem = EXCLUDED.origem
            WHERE vigia.conector_faixas.modo = 'vendor'`;
        }
      });
      res.push({ vendor: v.nome, faixas: faixas.length });
    } catch (e) {
      console.error(`vendores: ${v.nome} falhou: ${(e as Error).message}`);
      res.push({ vendor: v.nome, faixas: 0, erro: (e as Error).message });
    }
  }
  return res;
}

/** Faixas de conector guardadas e vigentes (vendedores + decisões não vencidas). */
export async function faixasConectorTabela(sql: Sql): Promise<string[]> {
  const rows = await sql`
    SELECT faixa FROM vigia.conector_faixas
    WHERE expira IS NULL OR expira > now()
    ORDER BY faixa`;
  return rows.map((r) => String(r.faixa));
}
