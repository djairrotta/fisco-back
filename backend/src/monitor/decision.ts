import type { Parecer } from "../ai/triage.ts";
import { type Incidente, soBorda } from "./types.ts";

export type Decisao = {
  acao: "bloquear" | "sugerir" | "registrar";
  motivo: string;
  classe: string;
  observacao: boolean;
  /** Duração do bloqueio automático, quando a regra a define (padrão do executor: 7). */
  dias?: number;
  /** Regra que bloqueia (ou teria bloqueado): Jev+2ª opinião ou reserva. */
  regra?: "jev" | "reserva";
  /** Sem bloqueio: por quê, curto, para a linha de status do push. */
  naoBloqueou?: string;
};

/**
 * Regra do Djair: Jev numa classe maliciosa com confiança ≥ jev_limiar
 * (config_geral, padrão 0,5) bloqueia por 7 dias. Com jev_exige_segunda, a 2ª
 * opinião (papel segunda ou terceira) também precisa da mesma classe ≥ limiar.
 */
export const JEV_LIMIAR_PADRAO = 0.5;
export const JEV_LIMIAR_MIN = 0.3;
export const JEV_LIMIAR_MAX = 0.95;
export const DIAS_BLOQUEIO_JEV = 7;
/** Duração do bloqueio das regras de reserva (padrão do executor). */
export const DIAS_BLOQUEIO_PADRAO = 7;
const EPS = 1e-9;

export type CtxDecisao = {
  permitidos: Set<string>;
  /** IPs de uso do administrador (vigia.ips_admin, 7 dias): protegidos como permitidos. */
  ipsAdmin?: Set<string>;
  ipsCloudflare: string[];
  ehBotVerificado: (ip: string) => boolean;
  modoObservacao: boolean;
  /** Confiança mínima do Jev (0,3..0,95; fora disso: JEV_LIMIAR_PADRAO). */
  jevLimiar?: number;
  /** true: exige 2ª opinião da mesma classe ≥ limiar (regra antiga). */
  jevExigeSegunda?: boolean;
};

/** Limiar válido do Jev; valor ausente, inválido ou fora da faixa → padrão. */
export function limiarJev(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= JEV_LIMIAR_MIN - EPS &&
      n <= JEV_LIMIAR_MAX + EPS
    ? n
    : JEV_LIMIAR_PADRAO;
}

/** Faixas publicadas pelo Cloudflare (https://www.cloudflare.com/ips/). */
export const CLOUDFLARE_IPS_PADRAO: string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const MALICIOSAS = new Set([
  "invasao",
  "raspagem",
  "forca_bruta",
  "varredura",
  "credential_stuffing",
]);

type Ip = { v: 4 | 6; n: bigint };

function parseV4(s: string): bigint | null {
  const p = s.split(".");
  if (p.length !== 4) return null;
  let n = 0n;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function parseV6(s: string): bigint | null {
  if (s.includes("%")) s = s.slice(0, s.indexOf("%"));
  let tail: bigint[] = [];
  // sufixo IPv4 embutido (ex.: ::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = parseV4(m[2]);
    if (v4 === null) return null;
    tail = [v4 >> 16n, v4 & 0xffffn];
    s = m[1] + "0:0";
  }
  const dup = s.split("::");
  if (dup.length > 2) return null;
  const grupos = (t: string) => t === "" ? [] : t.split(":");
  const head = grupos(dup[0]);
  const rest = dup.length === 2 ? grupos(dup[1]) : [];
  const total = head.length + rest.length;
  if (dup.length === 1 ? total !== 8 : total > 7) return null;
  const todos = dup.length === 1
    ? head
    : [...head, ...Array(8 - total).fill("0"), ...rest];
  let n = 0n;
  for (const g of todos) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail.length) n = (n & ~0xffffffffn) | (tail[0] << 16n) | tail[1];
  return n;
}

function parseIp(s: string): Ip | null {
  if (s.includes(":")) {
    const n = parseV6(s);
    if (n === null) return null;
    // IPv4-mapped (::ffff:a.b.c.d) vira IPv4.
    if ((n >> 32n) === 0xffffn) return { v: 4, n: n & 0xffffffffn };
    return { v: 6, n };
  }
  const n = parseV4(s);
  return n === null ? null : { v: 4, n };
}

/** true se `s` é um endereço IPv4 ou IPv6 (sem prefixo CIDR). */
export function ipValido(s: string): boolean {
  // Sem prefixo CIDR nem zone id (%): o Postgres rejeita "fe80::1%eth0" como inet.
  return !s.includes("/") && !s.includes("%") && parseIp(s.trim()) !== null;
}

/** true se `ip` (v4 ou v6) pertence ao bloco `cidr`. Entrada inválida: false. */
export function ipEmCidr(ip: string, cidr: string): boolean {
  const barra = cidr.indexOf("/");
  if (barra < 0) return false;
  const base = parseIp(cidr.slice(0, barra));
  const alvo = parseIp(ip);
  const pref = cidr.slice(barra + 1);
  if (!base || !alvo || !/^\d{1,3}$/.test(pref)) return false;
  const bits = base.v === 4 ? 32 : 128;
  let p = Number(pref);
  // Base IPv4-mapped com prefixo v6 (>= 96): converte o prefixo para v4.
  if (base.v === 4 && cidr.includes(":") && p >= 96) p -= 96;
  if (p > bits || base.v !== alvo.v) return false;
  const shift = BigInt(bits - p);
  return (base.n >> shift) === (alvo.n >> shift);
}

/** Igualdade canônica de IPs (v6 normalizado, case-insensitive) ou CIDR. */
export function ipCasa(ip: string, entrada: string): boolean {
  const e = entrada.trim();
  if (e.includes("/")) return ipEmCidr(ip, e);
  const a = parseIp(ip), b = parseIp(e);
  if (a && b) return a.v === b.v && a.n === b.n;
  return ip.toLowerCase() === e.toLowerCase();
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const duracao = (dias: number) => dias === 1 ? "24 h" : `${dias} dias`;
/** Famílias de modelo conhecidas → rótulo curto (push e motivo). */
const FAMILIAS: [RegExp, string][] = [
  [/^deepseek/i, "DeepSeek"],
  [/^glm/i, "GLM"],
  [/^gpt-/i, "GPT"],
  [/^jev-/i, "Jev"],
  [/^claude/i, "Claude"],
  [/^gemini/i, "Gemini"],
  [/^grok/i, "Grok"],
  [/^qwen/i, "Qwen"],
  [/^kimi/i, "Kimi"],
  [/^llama/i, "Llama"],
  [/^mistral/i, "Mistral"],
];

/**
 * Rótulo curto do modelo configurado num papel: "deepseek/deepseek-v4.1-flash"
 * → "DeepSeek", "z-ai/glm-5.3-flash" → "GLM", "typesafe/jev-1.13" → "Jev".
 * Desconhecido: a parte do modelo do slug (sem o sufixo ":variante").
 */
export function rotuloModelo(modelo: string, papel?: string): string {
  const parte = (modelo ?? "").trim().split("/").pop()!.split(":")[0].trim();
  if (!parte) return papel === "jev" ? "Jev" : papel ?? "IA";
  return FAMILIAS.find(([re]) => re.test(parte))?.[1] ?? parte;
}
const nomeIa = (p: Parecer) => rotuloModelo(p.modelo, p.papel);
const ORDEM_PAPEL: Record<string, number> = { jev: 0, segunda: 1, terceira: 2 };
const SEM_REGRA_JEV =
  "regra do Jev não atingida; reserva só vale sem Jev válido";

/** "Jev 41% (abaixo de 50%); DeepSeek invasao 88%; GLM falhou". */
function resumoIas(pareceres: Parecer[], limiar: number): string {
  const ps = [...pareceres].sort((a, b) =>
    (ORDEM_PAPEL[a.papel] ?? 9) - (ORDEM_PAPEL[b.papel] ?? 9)
  );
  if (ps.length === 0) return "sem pareceres das IAs";
  return ps.map((p) => {
    const nome = nomeIa(p);
    if (!p.ok) return `${nome} falhou`;
    if (
      p.papel === "jev" && MALICIOSAS.has(p.classe) &&
      p.confianca < limiar - EPS
    ) {
      return `${nome} ${pct(p.confianca)} (abaixo de ${pct(limiar)})`;
    }
    return `${nome} ${p.classe} ${pct(p.confianca)}`;
  }).join("; ");
}

export function decidir(
  inc: Incidente,
  pareceres: Parecer[],
  ctx: CtxDecisao,
): Decisao {
  const validos = pareceres.filter((p) => p.ok);
  const maliciosos = validos.filter((p) => MALICIOSAS.has(p.classe));

  // Classe vencedora: maliciosa com ≥ 2 votos (maior nº de votos, depois maior média).
  const porClasse = new Map<string, Parecer[]>();
  for (const p of maliciosos) {
    porClasse.set(p.classe, [...(porClasse.get(p.classe) ?? []), p]);
  }
  const media = (ps: Parecer[]) =>
    ps.reduce((a, p) => a + p.confianca, 0) / ps.length;
  let vencedora: { classe: string; ps: Parecer[]; media: number } | null = null;
  for (const [classe, ps] of porClasse) {
    if (ps.length < 2) continue;
    const m = media(ps);
    if (
      !vencedora || ps.length > vencedora.ps.length ||
      (ps.length === vencedora.ps.length && m > vencedora.media)
    ) vencedora = { classe, ps, media: m };
  }

  const classeFallback = (): string => {
    const grupos = new Map<string, Parecer[]>();
    for (const p of validos) {
      grupos.set(p.classe, [...(grupos.get(p.classe) ?? []), p]);
    }
    let melhor = "incerto", n = 0, mm = -1;
    for (const [c, ps] of grupos) {
      const m = media(ps);
      if (ps.length > n || (ps.length === n && m > mm)) {
        melhor = c;
        n = ps.length;
        mm = m;
      }
    }
    return melhor;
  };

  // Regra do Djair: Jev ≥ limiar numa classe maliciosa bloqueia. Com
  // jev_exige_segunda, a 2ª opinião (papel segunda ou terceira) precisa da
  // MESMA classe com ≥ limiar.
  const limiar = limiarJev(ctx.jevLimiar);
  const exigeSegunda = ctx.jevExigeSegunda === true;
  const jevMal = validos.find((p) =>
    p.papel === "jev" && MALICIOSAS.has(p.classe) &&
    p.confianca >= limiar - EPS
  );
  const confirmacao = jevMal && exigeSegunda
    ? validos
      .filter((p) =>
        (p.papel === "segunda" || p.papel === "terceira") &&
        p.classe === jevMal.classe &&
        p.confianca >= limiar - EPS
      )
      .sort((a, b) => b.confianca - a.confianca)[0]
    : undefined;
  const regraJev = jevMal !== undefined &&
    (!exigeSegunda || confirmacao !== undefined);

  const classe = regraJev && jevMal
    ? jevMal.classe
    : vencedora?.classe ?? classeFallback();

  const dec = (
    acao: Decisao["acao"],
    motivo: string,
    dias?: number,
    regra?: Decisao["regra"],
    naoBloqueou?: string,
  ): Decisao => {
    if (acao === "bloquear" && ctx.modoObservacao) {
      return {
        acao: "sugerir",
        motivo: `Teria bloqueado: ${motivo}`,
        classe,
        observacao: true,
        dias: dias ?? DIAS_BLOQUEIO_PADRAO,
        ...(regra ? { regra } : {}),
        naoBloqueou: "modo observação",
      };
    }
    const d: Decisao = { acao, motivo, classe, observacao: false };
    if (dias !== undefined) d.dias = dias;
    if (acao === "bloquear" && regra) d.regra = regra;
    if (naoBloqueou !== undefined) d.naoBloqueou = naoBloqueou;
    return d;
  };

  // 1. Nunca bloquear IP protegido.
  const protegido = inc.ips.find((ip) =>
    [...ctx.permitidos].some((e) => ipCasa(ip, e)) ||
    [...(ctx.ipsAdmin ?? [])].some((e) => ipCasa(ip, e)) ||
    ctx.ehBotVerificado(ip) ||
    ctx.ipsCloudflare.some((c) => ipEmCidr(ip, c))
  );
  if (protegido !== undefined) {
    const base =
      `IP ${protegido} é permitido, do administrador, do Cloudflare ou bot verificado`;
    return maliciosos.length
      ? dec(
        "sugerir",
        `${base}; não bloqueia automaticamente`,
        undefined,
        undefined,
        "IP protegido",
      )
      : dec("registrar", base);
  }

  // 2. Só geo/datacenter: a regra da borda já barra.
  if (soBorda(inc.sinais)) {
    return inc.sinais.every((s) => s.tipo === "geo")
      ? dec("registrar", "Apenas sinal geográfico; sem outros indícios")
      : dec(
        "registrar",
        "Apenas sinal de origem (estrangeiro/datacenter) já barrado na borda; sem outros indícios",
      );
  }

  // 3. Regra do Djair (primeira regra de decisão): Jev ≥ limiar (e, se
  // exigida, a 2ª opinião na mesma classe ≥ limiar).
  if (regraJev && jevMal) {
    const jevTxt = `${nomeIa(jevMal)} ${jevMal.classe} ${
      pct(jevMal.confianca)
    }`;
    const segTxt = confirmacao
      ? ` + ${nomeIa(confirmacao)} ${confirmacao.classe} ${
        pct(confirmacao.confianca)
      }`
      : "";
    return dec(
      "bloquear",
      `${jevTxt}${segTxt} ≥ ${pct(limiar)} → bloqueio ${
        duracao(DIAS_BLOQUEIO_JEV)
      }`,
      DIAS_BLOQUEIO_JEV,
      "jev",
    );
  }

  // Regras de reserva (4 e 5) só quando o Jev está ausente ou falhou: com
  // parecer VÁLIDO do Jev (qualquer classe), só a regra 3 bloqueia.
  const jevValido = validos.some((p) => p.papel === "jev");

  // 4. Consenso das IAs (reserva: Jev ausente/falhou).
  if (!jevValido && vencedora && vencedora.media >= 0.8 - 1e-9) {
    return dec(
      "bloquear",
      `Reserva (sem Jev válido): ${vencedora.ps.length} de ${pareceres.length} IAs ${vencedora.classe}, média ${
        pct(vencedora.media)
      } ≥ 80% → bloqueio ${duracao(DIAS_BLOQUEIO_PADRAO)}`,
      undefined,
      "reserva",
    );
  }

  // 5. scan + ua alta com ≥ 1 parecer malicioso (reserva: Jev ausente/falhou).
  const alta = (t: string) =>
    inc.sinais.some((s) => s.tipo === t && s.severidade === "alta");
  if (!jevValido && alta("scan") && alta("ua") && maliciosos.length >= 1) {
    return dec(
      "bloquear",
      `Reserva (sem Jev válido): varredura e user-agent suspeito de severidade alta + ${maliciosos.length} IA${
        maliciosos.length > 1 ? "s" : ""
      } (${classe}) → bloqueio ${duracao(DIAS_BLOQUEIO_PADRAO)}`,
      undefined,
      "reserva",
    );
  }

  // 6. Sugerir: o motivo diz qual regra faltou.
  if (maliciosos.length >= 1 || inc.severidadeMax === "alta") {
    const jev = validos.find((p) => p.papel === "jev");
    let falta: string, curto: string;
    if (!jev) {
      falta =
        "sem Jev válido; reserva não atingida (≥ 2 IAs na mesma classe com média ≥ 80%, ou varredura + user-agent de severidade alta)";
      curto = "sem Jev válido e reserva não atingida";
    } else if (!MALICIOSAS.has(jev.classe)) {
      falta = `Jev não apontou ataque; ${SEM_REGRA_JEV}`;
      curto = `${nomeIa(jev)} classificou como ${jev.classe}`;
    } else if (!jevMal) {
      falta = SEM_REGRA_JEV;
      curto = `${nomeIa(jev)} ${pct(jev.confianca)} abaixo de ${pct(limiar)}`;
    } else {
      falta = `2ª opinião não confirmou ${jevMal.classe} com ≥ ${
        pct(limiar)
      }; ${SEM_REGRA_JEV}`;
      curto = "2ª opinião discordou";
    }
    const motivo = maliciosos.length === 0 && validos.length === 0
      ? `Severidade alta sem parecer das IAs — ${falta}`
      : `${resumoIas(pareceres, limiar)} — ${falta}`;
    return dec("sugerir", motivo, undefined, undefined, curto);
  }

  // 7. Registrar.
  return dec("registrar", "Sem indícios suficientes");
}
