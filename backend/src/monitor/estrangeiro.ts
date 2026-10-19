// Vigia 1.1 (I): acesso estrangeiro — barrado pela regra "Vigia: fora do Brasil" ou passou.
// UMA definição de "passou", usada pelo detector, pelo agregado e (em SQL) pelos selos.
import { casaExcecao } from "./caminhos.ts";
import { ipCasa } from "./decision.ts";
import type { Evento } from "./types.ts";

/** Descrição da regra geo criada pelo Vigia em cada zona. */
export const DESCRICAO_GEO = "Vigia: fora do Brasil";
/** Ações do Cloudflare que impedem o acesso (nomes do GraphQL e dos logs). */
export const ACOES_BARRADAS = [
  "block",
  "managed_challenge",
  "managedchallenge",
];
export const MOTIVO_PASSOU = "não barrado pela regra Fora do Brasil";

export const estrangeiro = (e: Pick<Evento, "pais">) =>
  e.pais !== "" && e.pais.toUpperCase() !== "BR";

/** Evento de firewall da NOSSA regra geo com ação que barra o acesso. */
export function barradoPelaGeo(e: Evento): boolean {
  return e.fonte === "firewall" && e.regraCf === DESCRICAO_GEO &&
    ACOES_BARRADAS.includes(e.acaoCf.toLowerCase());
}

/** Status que só a origem devolve: 2xx, 3xx ou 404 (403/429/5xx podem ser da borda). */
export function statusDeOrigem(status: number): boolean {
  return (status >= 200 && status < 400) || status === 404;
}

export interface CtxPassou {
  /** Ativação da regra geo (null: regra desligada). */
  geoAtivoDesde: Date | null;
  excecoes: string[];
  vigiaHost: string;
  /** IPs/CIDRs permitidos vigentes (inclui modo viagem). */
  permitidos: string[];
  /** IPs verificados como bots (cf.client.bot é isento por desenho). */
  bots: Set<string>;
}

/**
 * Requisição estrangeira que chegou à origem apesar da regra geo: regra ativa e
 * requisição após a ativação; status de origem; fora de caminho de exceção, do
 * host do Vigia, de permitidos e de bots verificados.
 */
export function passouGeo(e: Evento, ctx: CtxPassou): boolean {
  return e.fonte === "http" && estrangeiro(e) &&
    ctx.geoAtivoDesde !== null && e.ts >= ctx.geoAtivoDesde &&
    statusDeOrigem(e.status) &&
    e.host.toLowerCase() !== ctx.vigiaHost.toLowerCase() &&
    !ctx.excecoes.some((p) => casaExcecao(e.caminho, p)) &&
    !ctx.permitidos.some((p) => ipCasa(e.ip, p)) &&
    !ctx.bots.has(e.ip);
}

export interface ResumoZona {
  zonaId: number;
  ipsBarrados: Set<string>;
  reqBarradas: number;
  passaram: { ip: string; caminho: string; status: number; n: number }[];
}

/** Por zona: IPs estrangeiros barrados pela regra geo e acessos que passaram. */
export function resumoEstrangeiros(
  eventos: Evento[],
  ctx: CtxPassou,
): ResumoZona[] {
  const zonas = new Map<number, ResumoZona>();
  const zona = (id: number) => {
    let z = zonas.get(id);
    if (!z) {
      z = { zonaId: id, ipsBarrados: new Set(), reqBarradas: 0, passaram: [] };
      zonas.set(id, z);
    }
    return z;
  };
  const vistos = new Map<string, ResumoZona["passaram"][number]>();
  for (const e of eventos) {
    if (barradoPelaGeo(e)) {
      const z = zona(e.zonaId);
      z.ipsBarrados.add(e.ip);
      z.reqBarradas += e.contagem || 1;
    } else if (passouGeo(e, ctx)) {
      const k = `${e.zonaId}|${e.ip}|${e.caminho}`;
      const p = vistos.get(k);
      if (p) p.n += e.contagem || 1;
      else {
        const novo = {
          ip: e.ip,
          caminho: e.caminho,
          status: e.status,
          n: e.contagem || 1,
        };
        vistos.set(k, novo);
        zona(e.zonaId).passaram.push(novo);
      }
    }
  }
  return [...zonas.values()].sort((a, b) => a.zonaId - b.zonaId);
}

/** Padrões LIKE (Postgres) equivalentes às exceções de caminho (`*` só no fim). */
export function padroesLike(excecoes: string[]): string[] {
  return excecoes.map((p) => {
    const pref = p.endsWith("*") ? p.slice(0, -1) : p;
    const esc = pref.replace(/[\\%_]/g, (c) => "\\" + c);
    return p.endsWith("*") ? esc + "%" : esc;
  });
}
