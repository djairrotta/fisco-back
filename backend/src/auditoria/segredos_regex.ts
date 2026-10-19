// Varredura de segredos vazados em respostas públicas (HTML e bundles .js).
// Regras no estilo do gitleaks, mas implementadas em Deno puro. NUNCA
// guardamos nem reportamos o segredo inteiro: só o TIPO, o arquivo e uma
// impressão digital de 4 caracteres (2 do início + 2 do fim).
import type { Severidade } from "./verificacoes.ts";

export interface SegredoEncontrado {
  /** Tipo do segredo (rótulo nosso, nunca o valor). */
  tipo: string;
  severidade: Severidade;
  /** Impressão digital curta: 2 primeiros + 2 últimos caracteres do achado. */
  mascara: string;
}

interface Regra {
  tipo: string;
  severidade: Severidade;
  re: RegExp;
  /** Validação extra do trecho casado (ex.: decodificar o JWT). */
  confirmar?: (bruto: string) => boolean;
}

/** Impressão digital de 4 caracteres; o resto vira "…", nunca o valor. */
export function mascarar(bruto: string): string {
  const s = bruto.replace(/\s+/g, "");
  if (s.length <= 4) return `${"•".repeat(s.length)}`;
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}

/** Decodifica o payload de um JWT e diz se o papel é service_role. */
export function jwtServiceRole(jwt: string): boolean {
  const partes = jwt.split(".");
  if (partes.length !== 3) return false;
  try {
    let b64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = JSON.parse(atob(b64));
    return json?.role === "service_role";
  } catch {
    return false;
  }
}

// Ordem: as regras mais específicas vêm antes das genéricas.
export const REGRAS: Regra[] = [
  {
    tipo: "Chave do Resend (re_...)",
    severidade: "alta",
    re: /\bre_[A-Za-z0-9]{20,}\b/g,
  },
  {
    tipo: "Chave do OpenRouter (sk-or-...)",
    severidade: "alta",
    re: /\bsk-or-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    tipo: "Chave da Stripe de produção (sk_live_...)",
    severidade: "alta",
    re: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    tipo: "Access key da AWS (AKIA...)",
    severidade: "alta",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    tipo: "Chave de API do Google (AIza...)",
    severidade: "alta",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    // JWT do Supabase: só é achado se o papel decodificado for service_role.
    tipo: "JWT service_role do Supabase",
    severidade: "alta",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    confirmar: jwtServiceRole,
  },
  {
    tipo: "Cabeçalho de chave privada",
    severidade: "alta",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    // Genérica: sk- seguido de 20+ alfanuméricos (não casa sk-or- nem sk_live_).
    tipo: "Chave secreta genérica (sk-...)",
    severidade: "media",
    re: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
];

const LIMITE_VARREDURA = 4 * 1024 * 1024;

/**
 * Procura segredos num texto público. Devolve só TIPO + máscara de 4 chars,
 * sem repetir o mesmo (tipo+máscara). Nunca retorna o valor inteiro.
 */
export function procurarSegredos(texto: string): SegredoEncontrado[] {
  const t = texto.length > LIMITE_VARREDURA
    ? texto.slice(0, LIMITE_VARREDURA)
    : texto;
  const vistos = new Set<string>();
  const out: SegredoEncontrado[] = [];
  for (const regra of REGRAS) {
    regra.re.lastIndex = 0;
    for (const m of t.matchAll(regra.re)) {
      const bruto = m[0];
      if (regra.confirmar && !regra.confirmar(bruto)) continue;
      const mascara = mascarar(bruto);
      const chave = `${regra.tipo}\u0000${mascara}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      out.push({ tipo: regra.tipo, severidade: regra.severidade, mascara });
    }
  }
  return out;
}
