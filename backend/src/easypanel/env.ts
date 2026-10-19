// Higiene das variáveis de ambiente dos apps do EasyPanel. Os valores só são
// lidos em memória para a análise: nunca são gravados, registrados, enviados
// por push ou a uma IA. Os achados citam apenas o NOME da variável; o reuso
// entre apps é comparado por hash SHA-256.
import type { Achado, Severidade } from "../auditoria/verificacoes.ts";

export const VERIFICACAO_ENV = "env";

const PREFIXO_PUBLICO = /^(VITE_|NEXT_PUBLIC_|REACT_APP_|PUBLIC_)/;
/** Nomes que indicam segredo (exceto chaves públicas por desenho). */
const NOME_SEGREDO =
  /(SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|PASSWD|SENHA|(^|_)PWD($|_)|(^|_)PASS($|_)|RESEND|OPENROUTER|OPENAI|ANTHROPIC|(^|_)TOKEN($|_)|API_?KEY|ACCESS_KEY)/;
const NOME_PUBLICO_OK = /(ANON|PUBLISHABLE|PUBLIC_KEY|SITE_KEY|_URL$|_HOST$)/;

/** Lê o env do EasyPanel ("CHAVE=valor" por linha). */
export function lerEnv(bruto: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const linha of bruto.split(/\r?\n/)) {
    const l = linha.trim().replace(/^export\s+/, "");
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i <= 0) continue;
    const k = l.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) continue;
    let v = l.slice(i + 1).trim();
    if (
      v.length >= 2 &&
      ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'")))
    ) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function papelJwt(v: string): string | null {
  const m = /^eyJ[\w-]+\.([\w-]+)\.[\w-]*$/.exec(v.trim());
  if (!m) return null;
  try {
    const b = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(b + "=".repeat((4 - b.length % 4) % 4)));
    return typeof j?.role === "string" ? j.role : null;
  } catch {
    return null;
  }
}

/** O VALOR tem formato de segredo conhecido? */
function valorSegredo(v: string): boolean {
  const t = v.trim();
  const papel = papelJwt(t);
  if (papel === "service_role" || papel === "supabase_admin") return true;
  return /^re_[A-Za-z0-9_]{16,}$/.test(t) || // Resend
    /^sk-or-/.test(t) || // OpenRouter
    /^sk_live_/.test(t) || /^rk_live_/.test(t) || // Stripe
    /^sk-ant-/.test(t) ||
    /^sk-[A-Za-z0-9_-]{20,}$/.test(t) || // OpenAI e afins
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t);
}

/** Nome ou valor parece segredo. */
export function pareceSegredo(nome: string, valor: string): boolean {
  if (valorSegredo(valor)) return true;
  const n = nome.toUpperCase();
  return NOME_SEGREDO.test(n) && !NOME_PUBLICO_OK.test(n);
}

const NAO_PRODUCAO =
  /(^|[-_.])(dev|develop|staging|stage|stg|homolog|hml|test|teste|testes|preview|sandbox|qa)([-_.]|$)/i;

/** Produção = publicado em algum domínio e sem dev/staging/teste no nome. */
export function ehProducao(
  a: { projeto: string; servico: string; dominios: string[] },
): boolean {
  return a.dominios.length > 0 && !NAO_PRODUCAO.test(a.projeto) &&
    !NAO_PRODUCAO.test(a.servico);
}

export interface EnvApp {
  /** "projeto/serviço". */
  chave: string;
  producao: boolean;
  env: Record<string, string>;
}

type Problema =
  | "frontend"
  | "ambiente"
  | "debug"
  | "reuso";

const SEV: Record<Problema, Severidade> = {
  frontend: "alta",
  ambiente: "media",
  debug: "media",
  reuso: "media",
};
const ROTULO: Record<Problema, string> = {
  frontend: "segredo exposto no frontend",
  ambiente: "não está em production",
  debug: "DEBUG ligado",
  reuso: "mesmo segredo em outro app",
};
const TITULO: Record<Problema, string> = {
  frontend: "Segredo em variável pública do frontend",
  ambiente: "App de produção fora do modo production",
  debug: "DEBUG ligado em produção",
  reuso: "Mesmo segredo usado em vários apps",
};
const RECOMENDACAO: Record<Problema, string> = {
  frontend:
    "Variáveis com prefixo VITE_, NEXT_PUBLIC_, REACT_APP_ ou PUBLIC_ vão para o navegador: tire o segredo do frontend (use-o só no backend/edge function), troque a chave (considere-a vazada) e faça novo deploy.",
  ambiente:
    "Defina NODE_ENV=production (ou ENV=production) no app de produção: fora dele, frameworks mostram stack traces e desligam proteções.",
  debug:
    "Desligue DEBUG em produção: modo debug expõe detalhes internos e erros completos.",
  reuso:
    "Use um segredo diferente por app (se um app vazar, os outros continuam seguros); se o reuso for intencional (mesmo backend), avalie separar as chaves.",
};
const ORDEM: Problema[] = ["frontend", "reuso", "ambiente", "debug"];
const RANK: Record<Severidade, number> = { baixa: 1, media: 2, alta: 3 };

async function sha256(v: string): Promise<string> {
  const h = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(v),
  );
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const verdadeiro = (v: string) => /^(true|1|yes|on|\*)$/i.test(v.trim());
const ehProd = (v: string) => /^(production|prod)$/i.test(v.trim());

/**
 * Analisa o env de cada app; devolve, por chave, um achado agregado
 * (verificação "env") ou null quando está limpo.
 */
export async function analisarEnv(
  apps: EnvApp[],
): Promise<Map<string, Achado | null>> {
  // Reuso: hash do valor → apps/variáveis (só valores com cara de segredo).
  const porHash = new Map<string, { chave: string; nome: string }[]>();
  for (const a of apps) {
    for (const [nome, valor] of Object.entries(a.env)) {
      if (valor.trim().length < 12 || !pareceSegredo(nome, valor)) continue;
      const h = await sha256(valor.trim());
      const l = porHash.get(h) ?? [];
      l.push({ chave: a.chave, nome });
      porHash.set(h, l);
    }
  }
  const reuso = new Map<string, { nome: string; outros: string[] }[]>();
  for (const l of porHash.values()) {
    const chaves = [...new Set(l.map((x) => x.chave))];
    if (chaves.length < 2) continue;
    for (const x of l) {
      const r = reuso.get(x.chave) ?? [];
      if (!r.some((y) => y.nome === x.nome)) {
        r.push({
          nome: x.nome,
          outros: chaves.filter((c) => c !== x.chave).sort(),
        });
      }
      reuso.set(x.chave, r);
    }
  }

  const out = new Map<string, Achado | null>();
  for (const a of apps) {
    const itens: { nome: string; problema: Problema; extra?: string }[] = [];
    for (const [nome, valor] of Object.entries(a.env)) {
      const n = nome.toUpperCase();
      if (PREFIXO_PUBLICO.test(n) && valor.trim() && pareceSegredo(n, valor)) {
        itens.push({ nome, problema: "frontend" });
      }
      if (
        a.producao && (n === "NODE_ENV" || n === "ENV") && valor.trim() &&
        !ehProd(valor)
      ) itens.push({ nome, problema: "ambiente" });
      if (n === "DEBUG" && verdadeiro(valor)) {
        itens.push({ nome, problema: "debug" });
      }
    }
    for (const r of reuso.get(a.chave) ?? []) {
      itens.push({
        nome: r.nome,
        problema: "reuso",
        extra: r.outros.join(", "),
      });
    }
    if (!itens.length) {
      out.set(a.chave, null);
      continue;
    }
    const problemas = ORDEM.filter((p) => itens.some((i) => i.problema === p));
    const severidade = problemas.map((p) => SEV[p])
      .reduce((m, s) => (RANK[s] > RANK[m] ? s : m), "baixa" as Severidade);
    itens.sort((x, y) =>
      ORDEM.indexOf(x.problema) - ORDEM.indexOf(y.problema) ||
      x.nome.localeCompare(y.nome)
    );
    out.set(a.chave, {
      verificacao: VERIFICACAO_ENV,
      severidade,
      titulo: problemas.length === 1
        ? TITULO[problemas[0]]
        : `Variáveis de ambiente: ${
          problemas.map((p) => ROTULO[p]).join("; ")
        }`,
      recomendacao: problemas.map((p) => RECOMENDACAO[p]).join(" "),
      evidencia: itens.map((i) =>
        `${i.nome} (${ROTULO[i.problema]}${i.extra ? `: ${i.extra}` : ""})`
      ).join("; "),
    });
  }
  return out;
}
