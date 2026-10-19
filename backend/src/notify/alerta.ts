// Vigia 1.2: linhas dos pushes de incidente — status do bloqueio (visível na
// tela bloqueada) e localização aproximada dos IPs (📍), com orçamento de tempo.
import { type DadosIp, ipPublico } from "../ip/localizar.ts";
import {
  type Origem,
  ROTULO_CURTO,
  rotuloDuracao,
} from "../monitor/origem_bloqueio.ts";

/** Orçamento total das consultas de localização de um push. */
export const ORCAMENTO_LOCAL_MS = 3000;
/** No máximo 3 IPs com 📍; o resto vira "+N". */
export const MAX_IPS_LOCAL = 3;

const BRASILIA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "10/10 22:35" (horário de Brasília). */
export const dataCurta = (d: Date) => BRASILIA.format(d).replace(",", "");

let nomesPais: Intl.DisplayNames | null = null;
function nomePais(codigo: string): string {
  try {
    nomesPais ??= new Intl.DisplayNames(["en"], { type: "region" });
    return nomesPais.of(codigo.toUpperCase()) ?? codigo;
  } catch {
    return codigo;
  }
}

/** Dado que veio de fora: sem quebras de linha nem controle, curto. */
const limpo = (v: unknown, max = 80) =>
  typeof v === "string"
    // deno-lint-ignore no-control-regex
    ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max)
    : "";

/** "📍 Augsburg/Bavaria, Germany · Feo Prest SRL (AS208137)"; sem dado útil: null. */
export function linhaLocal(
  l: Partial<
    Pick<
      DadosIp,
      "cidade" | "regiao" | "pais" | "pais_codigo" | "provedor" | "asn"
    >
  >,
): string | null {
  const pais = limpo(l.pais) || (l.pais_codigo ? nomePais(l.pais_codigo) : "");
  const lugar = [limpo(l.cidade), limpo(l.regiao)].filter(Boolean).join("/");
  const onde = [lugar, pais].filter(Boolean).join(", ");
  const asn = typeof l.asn === "number" && l.asn > 0 ? `AS${l.asn}` : "";
  const prov = limpo(l.provedor);
  const quem = prov && asn ? `${prov} (${asn})` : prov || asn;
  const partes = [onde, quem].filter(Boolean);
  return partes.length ? `📍 ${partes.join(" · ")}` : null;
}

export interface OpcoesLocal {
  /** Consulta com cache de 7 dias (localizarIp); ausente: só o Cloudflare. */
  localizar?: (ip: string) => Promise<DadosIp>;
  orcamentoMs?: number;
  /** País (código) e ASN que o Cloudflare já deu nos eventos. */
  cloudflare?: Map<string, { pais: string; asn: number }>;
  /** Prefixa cada linha com o IP (vários IPs no mesmo push). */
  comIp?: boolean;
}

/**
 * Linhas 📍 dos IPs públicos (no máx. 3, depois "+N"). Consultas em paralelo com
 * orçamento total; quem não respondeu a tempo usa país/ASN do Cloudflare ou some.
 * Nunca lança e nunca passa do orçamento.
 */
export async function locaisParaPush(
  ips: string[],
  o: OpcoesLocal,
): Promise<string[]> {
  const publicos = [...new Set(ips)].filter(ipPublico);
  const alvo = publicos.slice(0, MAX_IPS_LOCAL);
  const achados = new Map<string, DadosIp>();
  if (o.localizar && alvo.length > 0) {
    const consultar = o.localizar;
    const tarefas = alvo.map((ip) =>
      Promise.resolve()
        .then(() => consultar(ip))
        .then((d) => void achados.set(ip, d), () => {})
    );
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(tarefas),
      new Promise<void>((r) => {
        t = setTimeout(r, o.orcamentoMs ?? ORCAMENTO_LOCAL_MS);
      }),
    ]);
    clearTimeout(t);
  }
  const linhas: string[] = [];
  for (const ip of alvo) {
    const d = achados.get(ip);
    const cf = o.cloudflare?.get(ip);
    const l = (d ? linhaLocal(d) : null) ??
      (cf ? linhaLocal({ pais_codigo: cf.pais, asn: cf.asn }) : null);
    if (!l) continue;
    linhas.push(o.comIp ? l.replace("📍 ", `📍 ${ip} · `) : l);
  }
  if (publicos.length > alvo.length) {
    linhas.push(`+${publicos.length - alvo.length}`);
  }
  return linhas;
}

// ------------------------------------------------------------------ status

export type StatusIp =
  /** Bloqueado agora pela regra automática. */
  | {
    tipo: "bloqueado";
    dias: number;
    ate: Date | null;
    por: "jev" | "reserva";
  }
  /** Já havia bloqueio vigente (de quem o criou). */
  | { tipo: "ja_bloqueado"; ate: Date | null; por: Origem }
  /** Barrado na borda pela regra geo do Vigia. */
  | { tipo: "geo"; barradas: number }
  | { tipo: "nao"; motivo: string };

export function textoStatus(s: StatusIp): string {
  switch (s.tipo) {
    case "bloqueado":
      return `🔒 Bloqueado ${
        s.por === "jev" ? "pelo Jev" : "pelo bloqueio automático (reserva)"
      } por ${rotuloDuracao(s.dias)}${
        s.ate ? ` (até ${dataCurta(s.ate)})` : ""
      }`;
    case "ja_bloqueado":
      return `🔒 Já estava bloqueado ${
        s.ate ? `até ${dataCurta(s.ate)}` : "sem validade"
      } (${ROTULO_CURTO[s.por]})`;
    case "geo":
      return `🌎 Bloqueado pela regra Fora do Brasil (${s.barradas} ${
        s.barradas === 1 ? "requisição barrada" : "requisições barradas"
      })`;
    case "nao":
      return `⚠️ NÃO bloqueado — ${s.motivo}`;
  }
}

/** "a, b, c +2". */
export function tituloIps(ips: string[], max = 3): string {
  return ips.slice(0, max).join(", ") +
    (ips.length > max ? ` +${ips.length - max}` : "");
}

/**
 * Status de todos os IPs: um só texto quando todos têm o mesmo; senão uma
 * linha por status com os IPs dele.
 */
export function linhasStatus(
  ips: string[],
  status: Map<string, StatusIp>,
): string[] {
  const grupos = new Map<string, string[]>();
  for (const ip of ips) {
    const s = status.get(ip);
    if (!s) continue;
    const t = textoStatus(s);
    grupos.set(t, [...(grupos.get(t) ?? []), ip]);
  }
  if (grupos.size <= 1) return [...grupos.keys()];
  return [...grupos].map(([t, g]) => `${t} · ${tituloIps(g)}`);
}
