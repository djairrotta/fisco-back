import type { Evento, Sinal } from "./types.ts";
import { casaExcecao, soCaminho } from "./caminhos.ts";
import { type CtxPassou, passouGeo } from "./estrangeiro.ts";

export type { Sinal };

export const CAMINHOS_SENSIVEIS = [
  "/.env",
  "/.git",
  "/wp-admin",
  "/wp-login.php",
  "/phpmyadmin",
  "/xmlrpc.php",
  "/.aws",
  "/server-status",
  "/config.json",
  "/.DS_Store",
];

export const UA_FERRAMENTAS =
  /sqlmap|nikto|nmap|masscan|zgrab|nuclei|gobuster|dirbuster|wpscan|python-requests|go-http-client|curl\//i;

export type CtxDetector = {
  excecoesCaminho: string[];
  permitidos: Set<string>;
  medianaPorHost: Map<string, number>;
  limiares: { bruteforceN: number; rateK: number };
  /** Contexto da definição única de "passou" (ausente: sem sinal geo_passou). */
  passou?: CtxPassou;
  /** ASNs de datacenter/VPS barrados na borda (ausente/vazio: sem sinal). */
  asnsDatacenter?: ReadonlySet<number>;
};

const ROTA_AUTH =
  /(login|signin|sign-in|auth|token|session|wp-login\.php|admin)/i;
const EXT_ASSET = /\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map)$/i;
const JANELA_BRUTEFORCE_MS = 5 * 60_000;
const MAX_AMOSTRA = 5;
const SCRAPE_MIN_GETS = 200;
const SCRAPE_MAX_RAZAO_ASSET = 0.05;

const SEVERIDADE: Record<Sinal["tipo"], Sinal["severidade"]> = {
  geo: "media",
  geo_passou: "alta",
  datacenter: "baixa",
  bruteforce: "alta",
  scan: "alta",
  ua: "alta",
  rate: "media",
  scrape: "media",
};

function ehSensivel(caminho: string): boolean {
  const c = soCaminho(caminho).toLowerCase();
  return CAMINHOS_SENSIVEIS.some((s) => {
    const p = s.toLowerCase();
    return c === p || c.startsWith(p + "/");
  });
}

const ehAsset = (caminho: string) => EXT_ASSET.test(soCaminho(caminho));

const chaveGrupo = (e: Evento) => `${e.zonaId}|${e.host}|${e.ip}`;

function montar(tipo: Sinal["tipo"], evs: Evento[], contagem?: number): Sinal {
  const amostra: string[] = [];
  let ts = evs[0].ts;
  for (const e of evs) {
    if (e.ts > ts) ts = e.ts;
    if (amostra.length < MAX_AMOSTRA && !amostra.includes(e.caminho)) {
      amostra.push(e.caminho);
    }
  }
  return {
    tipo,
    ip: evs[0].ip,
    zonaId: evs[0].zonaId,
    host: evs[0].host,
    severidade: SEVERIDADE[tipo],
    amostra,
    contagem: contagem ?? evs.reduce((n, e) => n + e.contagem, 0),
    ts,
    asn: evs[0].asn,
  };
}

function agrupar(evs: Evento[]): Evento[][] {
  const m = new Map<string, Evento[]>();
  for (const e of evs) {
    const k = chaveGrupo(e);
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  }
  return [...m.values()];
}

function regraGeo(evs: Evento[], ctx: CtxDetector): Sinal[] {
  const sel = evs.filter((e) =>
    e.pais !== "" && e.pais.toUpperCase() !== "BR" &&
    !ctx.excecoesCaminho.some((p) => casaExcecao(e.caminho, p))
  );
  return agrupar(sel).map((g) => montar("geo", g));
}

/** Acesso de ASN de datacenter/VPS (a regra da borda já barra: severidade baixa). */
function regraDatacenter(evs: Evento[], ctx: CtxDetector): Sinal[] {
  const asns = ctx.asnsDatacenter;
  if (!asns || asns.size === 0) return [];
  const sel = evs.filter((e) =>
    e.asn > 0 && asns.has(e.asn) &&
    !ctx.excecoesCaminho.some((p) => casaExcecao(e.caminho, p))
  );
  return agrupar(sel).map((g) => montar("datacenter", g));
}

/** Acesso estrangeiro que NÃO foi barrado pela regra geo (só com a regra ligada). */
function regraGeoPassou(evs: Evento[], ctx: CtxDetector): Sinal[] {
  const cp = ctx.passou;
  if (!cp || cp.geoAtivoDesde === null) return [];
  return agrupar(evs.filter((e) => passouGeo(e, cp))).map((g) => {
    const s = montar("geo_passou", g);
    const amostra: string[] = [];
    for (const e of g) {
      const a = `${e.caminho.slice(0, 200)} (HTTP ${e.status})`;
      if (!amostra.includes(a) && amostra.length < MAX_AMOSTRA) amostra.push(a);
    }
    return { ...s, amostra };
  });
}

function regraBruteforce(evs: Evento[], ctx: CtxDetector): Sinal[] {
  // Volume: só fonte http (já inclui o que o firewall agiu; evita contar 2x).
  const sel = evs.filter((e) =>
    e.fonte === "http" && e.metodo.toUpperCase() === "POST" &&
    ROTA_AUTH.test(soCaminho(e.caminho))
  );
  const out: Sinal[] = [];
  for (const g of agrupar(sel)) {
    g.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    let ini = 0, soma = 0, melhor = 0;
    for (let fim = 0; fim < g.length; fim++) {
      soma += g[fim].contagem;
      while (
        g[fim].ts.getTime() - g[ini].ts.getTime() > JANELA_BRUTEFORCE_MS
      ) {
        soma -= g[ini].contagem;
        ini++;
      }
      if (soma > melhor) melhor = soma;
    }
    if (melhor >= ctx.limiares.bruteforceN) {
      out.push(montar("bruteforce", g));
    }
  }
  return out;
}

function regraScan(evs: Evento[]): Sinal[] {
  return agrupar(evs.filter((e) => ehSensivel(e.caminho))).map((g) =>
    montar("scan", g)
  );
}

function regraUa(evs: Evento[]): Sinal[] {
  return agrupar(evs.filter((e) => UA_FERRAMENTAS.test(e.ua))).map((g) =>
    montar("ua", g)
  );
}

function regraRate(evs: Evento[], ctx: CtxDetector): Sinal[] {
  const out: Sinal[] = [];
  for (const g of agrupar(evs.filter((e) => e.fonte === "http"))) {
    const mediana = ctx.medianaPorHost.get(g[0].host);
    if (mediana === undefined || !(mediana > 0)) continue;
    const total = g.reduce((n, e) => n + e.contagem, 0);
    if (total > ctx.limiares.rateK * mediana) out.push(montar("rate", g));
  }
  return out;
}

function regraScrape(evs: Evento[]): Sinal[] {
  const out: Sinal[] = [];
  const gets = evs.filter((e) =>
    e.fonte === "http" && e.metodo.toUpperCase() === "GET"
  );
  for (const g of agrupar(gets)) {
    const html = g.filter((e) => !ehAsset(e.caminho));
    const nHtml = html.reduce((n, e) => n + e.contagem, 0);
    if (nHtml <= SCRAPE_MIN_GETS) continue;
    const nAsset = g.reduce((n, e) => n + e.contagem, 0) - nHtml;
    if (nAsset / (nHtml + nAsset) < SCRAPE_MAX_RAZAO_ASSET) {
      out.push(montar("scrape", html));
    }
  }
  return out;
}

export function detectar(eventos: Evento[], ctx: CtxDetector): Sinal[] {
  const evs = eventos.filter((e) => !ctx.permitidos.has(e.ip));
  return [
    ...regraGeo(evs, ctx),
    ...regraGeoPassou(evs, ctx),
    ...regraDatacenter(evs, ctx),
    ...regraBruteforce(evs, ctx),
    ...regraScan(evs),
    ...regraUa(evs),
    ...regraRate(evs, ctx),
    ...regraScrape(evs),
  ];
}

/** Por host: mediana do total http (soma de contagem) por IP dentro do lote. */
export function medianaPorHost(eventos: Evento[]): Map<string, number> {
  const porHost = new Map<string, Map<string, number>>();
  for (const e of eventos) {
    if (e.fonte !== "http") continue;
    let ips = porHost.get(e.host);
    if (!ips) porHost.set(e.host, ips = new Map());
    ips.set(e.ip, (ips.get(e.ip) ?? 0) + e.contagem);
  }
  const out = new Map<string, number>();
  for (const [host, ips] of porHost) {
    const v = [...ips.values()].sort((a, b) => a - b);
    const m = v.length >> 1;
    out.set(host, v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
  }
  return out;
}
