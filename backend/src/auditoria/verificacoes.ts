// Auditoria diária de configuração dos sites do Djair: só GET/HEAD, sem
// corpo, sem credenciais, no máximo 1 requisição por segundo por host. Dos
// arquivos sensíveis registra só que existem — nunca o conteúdo.
import tls from "node:tls";

export const USER_AGENT = "Vigia-Auditoria/1.0 (+https://vigia.judinfo.com.br)";

export type Severidade = "baixa" | "media" | "alta";

export interface RespostaHttp {
  status: number;
  headers: Headers;
  /** Primeiros bytes do corpo (até `limiteBytes`). */
  corpo: Uint8Array;
}

export interface OpcoesRequisicao {
  metodo?: "GET" | "HEAD";
  /** Cabeçalhos extras (nunca credenciais). */
  headers?: Record<string, string>;
  limiteBytes?: number;
}

export interface ClienteAuditoria {
  /** Uma requisição sem seguir redirecionamento; rejeita em erro de rede/TLS. */
  requisitar(url: string, o?: OpcoesRequisicao): Promise<RespostaHttp>;
  /** Validade do certificado TLS servido em host:443. */
  certificado(host: string): Promise<{ validoAte: Date } | null>;
}

export interface Achado {
  verificacao: string;
  severidade: Severidade;
  /** Texto nosso (pt-BR); nunca leva texto vindo do site. */
  titulo: string;
  recomendacao: string;
  /** Texto vindo do site (ex.: valor do Server) — não confiável. */
  evidencia?: string;
}

export interface ResultadoHost {
  host: string;
  achados: Achado[];
  /** Verificações concluídas: só estas podem resolver achados antigos. */
  avaliadas: string[];
  /** A borda do Cloudflare barrou a própria auditoria (nada foi avaliado). */
  bloqueadoNaBorda?: boolean;
}

// ------------------------------------------------------------ assinaturas

const latin1 = new TextDecoder("latin1");
const texto = (b: Uint8Array) => latin1.decode(b);
const pareceHtml = (t: string) =>
  /^\s*(<!doctype\s+html|<html|<head|<body|<!--|<meta|<script)/i.test(t) ||
  /<html[\s>]/i.test(t);
const comeca = (b: Uint8Array, bytes: number[], desde = 0) =>
  b.length >= desde + bytes.length &&
  bytes.every((x, i) => b[desde + i] === x);

export interface ArquivoSensivel {
  caminho: string;
  severidade: Severidade;
  titulo: string;
  recomendacao: string;
  /** true se o corpo parece o arquivo de verdade (não um index.html de SPA). */
  assinatura(corpo: Uint8Array): boolean;
}

const BLOQUEAR =
  "Remova o arquivo do diretório publicado (ou bloqueie o caminho no servidor/Cloudflare) e";

export const ARQUIVOS_SENSIVEIS: ArquivoSensivel[] = [
  {
    caminho: "/.env",
    severidade: "alta",
    titulo: "Arquivo .env público",
    recomendacao:
      `${BLOQUEAR} troque todas as senhas e chaves que estavam nele: considere-as vazadas.`,
    assinatura: (b) => {
      const t = texto(b);
      return !pareceHtml(t) &&
        /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/m.test(t);
    },
  },
  {
    caminho: "/.git/HEAD",
    severidade: "alta",
    titulo: "Repositório .git público (HEAD)",
    recomendacao:
      `${BLOQUEAR} não publique a pasta .git: o código-fonte e o histórico (com segredos antigos) podem ser baixados.`,
    assinatura: (b) =>
      /^(ref:\s*refs\/|[0-9a-f]{40}\s*$)/.test(texto(b).trimStart()),
  },
  {
    caminho: "/.git/config",
    severidade: "alta",
    titulo: "Repositório .git público (config)",
    recomendacao:
      `${BLOQUEAR} não publique a pasta .git; confira se a URL do remoto tinha credenciais.`,
    assinatura: (b) => {
      const t = texto(b);
      return !pareceHtml(t) && /^\s*\[core\]/m.test(t);
    },
  },
  {
    caminho: "/.DS_Store",
    severidade: "baixa",
    titulo: "Arquivo .DS_Store público",
    recomendacao:
      `${BLOQUEAR} adicione .DS_Store ao .gitignore: ele lista os nomes de arquivos da pasta.`,
    assinatura: (b) => comeca(b, [0x42, 0x75, 0x64, 0x31], 4), // "Bud1"
  },
  {
    caminho: "/backup.zip",
    severidade: "alta",
    titulo: "Backup .zip público",
    recomendacao:
      `${BLOQUEAR} guarde backups fora da raiz pública; trate o conteúdo como vazado.`,
    assinatura: (b) =>
      comeca(b, [0x50, 0x4b, 0x03, 0x04]) ||
      comeca(b, [0x50, 0x4b, 0x05, 0x06]),
  },
  {
    caminho: "/db.sql",
    severidade: "alta",
    titulo: "Dump de banco de dados público",
    recomendacao:
      `${BLOQUEAR} guarde dumps fora da raiz pública; trate os dados e senhas do banco como vazados.`,
    assinatura: (b) => {
      const t = texto(b);
      return !pareceHtml(t) &&
        /(CREATE TABLE|INSERT INTO|DROP TABLE|--\s*(MySQL|MariaDB) dump|PostgreSQL database dump)/i
          .test(t);
    },
  },
  {
    caminho: "/phpinfo.php",
    severidade: "media",
    titulo: "phpinfo() público",
    recomendacao:
      `${BLOQUEAR} não deixe páginas de diagnóstico no ar: elas revelam versões, caminhos e variáveis de ambiente.`,
    assinatura: (b) => /phpinfo\(\)|PHP Version \d/i.test(texto(b)),
  },
  {
    caminho: "/server-status",
    severidade: "media",
    titulo: "Página server-status do Apache pública",
    recomendacao:
      "Restrinja o mod_status a localhost (Require local) ou desligue-o: ele mostra URLs e IPs dos visitantes.",
    assinatura: (b) =>
      /Apache Server Status|Server Version:\s*Apache|Total Accesses:/i.test(
        texto(b),
      ),
  },
];

// ------------------------------------------------------------ cabeçalhos

interface CabecalhoEsperado {
  id: string;
  severidade: Severidade;
  titulo: string;
  recomendacao: string;
  presente(h: Headers): boolean;
}

const CABECALHOS: CabecalhoEsperado[] = [
  {
    id: "strict-transport-security",
    severidade: "media",
    titulo: "Falta o cabeçalho Strict-Transport-Security (HSTS)",
    recomendacao:
      "Ligue o HSTS (Cloudflare → SSL/TLS → Edge Certificates → HSTS, ou no servidor: Strict-Transport-Security: max-age=31536000; includeSubDomains).",
    presente: (h) =>
      /max-age=\s*[1-9]/i.test(h.get("strict-transport-security") ?? ""),
  },
  {
    id: "content-security-policy",
    severidade: "media",
    titulo: "Falta o cabeçalho Content-Security-Policy",
    recomendacao:
      "Defina uma Content-Security-Policy (comece com default-src 'self' e libere só as origens que o app usa) para reduzir o impacto de XSS.",
    presente: (h) => (h.get("content-security-policy") ?? "").trim() !== "",
  },
  {
    id: "x-content-type-options",
    severidade: "baixa",
    titulo: "Falta X-Content-Type-Options: nosniff",
    recomendacao:
      "Envie X-Content-Type-Options: nosniff em todas as respostas (Transform Rule de cabeçalho no Cloudflare ou no servidor).",
    presente: (h) => /nosniff/i.test(h.get("x-content-type-options") ?? ""),
  },
  {
    id: "frame-ancestors",
    severidade: "media",
    titulo:
      "Site pode ser embutido em iframe (sem X-Frame-Options nem frame-ancestors)",
    recomendacao:
      "Envie X-Frame-Options: DENY (ou SAMEORIGIN) ou inclua frame-ancestors 'none' na Content-Security-Policy, contra clickjacking.",
    presente: (h) =>
      (h.get("x-frame-options") ?? "").trim() !== "" ||
      /frame-ancestors/i.test(h.get("content-security-policy") ?? ""),
  },
  {
    id: "referrer-policy",
    severidade: "baixa",
    titulo: "Falta o cabeçalho Referrer-Policy",
    recomendacao:
      "Envie Referrer-Policy: strict-origin-when-cross-origin para não vazar caminhos e parâmetros para outros sites.",
    presente: (h) => (h.get("referrer-policy") ?? "").trim() !== "",
  },
];

const VERSAO = /\d+\.\d+|\/\s*\d/;

// ------------------------------------------------------------ auditoria

const LIMITE_PAGINA = 64 * 1024;
const LIMITE_ARQUIVO = 4096;
const MAX_REDIRECTS = 3;
/** Origem fictícia (só para ver a resposta CORS; nada é enviado no corpo). */
const ORIGEM_TESTE = "https://auditoria.vigia.invalid";

const ehRedirect = (s: number) => s >= 300 && s < 400;
const DIA_MS = 86_400_000;

/** Segue redirecionamentos só dentro do mesmo host (HTTPS). */
async function paginaInicial(
  host: string,
  c: ClienteAuditoria,
): Promise<RespostaHttp> {
  let url = `https://${host}/`;
  let r = await c.requisitar(url, {
    headers: { Origin: ORIGEM_TESTE },
    limiteBytes: LIMITE_PAGINA,
  });
  for (let i = 0; i < MAX_REDIRECTS && ehRedirect(r.status); i++) {
    const loc = r.headers.get("location");
    if (!loc) break;
    let prox: URL;
    try {
      prox = new URL(loc, url);
    } catch {
      break;
    }
    if (prox.protocol !== "https:" || prox.hostname !== host) break;
    url = prox.toString();
    r = await c.requisitar(url, {
      headers: { Origin: ORIGEM_TESTE },
      limiteBytes: LIMITE_PAGINA,
    });
  }
  return r;
}

export async function auditarHost(
  host: string,
  c: ClienteAuditoria,
  agora: Date,
): Promise<ResultadoHost> {
  const achados: Achado[] = [];
  const avaliadas: string[] = [];
  const res = () => ({ host, achados, avaliadas });

  // 1. HTTPS
  let pagina: RespostaHttp;
  try {
    pagina = await paginaInicial(host, c);
  } catch {
    avaliadas.push("https");
    achados.push({
      verificacao: "https",
      severidade: "alta",
      titulo: "HTTPS não responde",
      recomendacao:
        "Confira o DNS, o proxy do Cloudflare e o certificado de origem; o site não abriu por HTTPS.",
    });
    return res();
  }
  if (bloqueioDaBorda(pagina)) {
    // A página de bloqueio não diz nada do site: não avaliar nem resolver.
    return { host, achados: [], avaliadas: [], bloqueadoNaBorda: true };
  }
  avaliadas.push("https");

  // 2. Certificado
  try {
    const cert = await c.certificado(host);
    if (cert) {
      avaliadas.push("tls_validade");
      const dias = Math.floor(
        (cert.validoAte.getTime() - agora.getTime()) / DIA_MS,
      );
      if (dias <= 20) {
        achados.push({
          verificacao: "tls_validade",
          severidade: dias <= 7 ? "alta" : "media",
          titulo: dias < 0
            ? "Certificado TLS vencido"
            : `Certificado TLS vence em ${dias} dia(s)`,
          recomendacao:
            "Renove o certificado (no Cloudflare, confira o Edge Certificate e o modo SSL; na origem, o certbot/ACME).",
          evidencia: `válido até ${cert.validoAte.toISOString()}`,
        });
      }
    }
  } catch {
    // sem certificado legível: não avaliado
  }

  // 3. Cabeçalhos de segurança, versão exposta e CORS
  const h = pagina.headers;
  for (const e of CABECALHOS) {
    const v = `cabecalho:${e.id}`;
    avaliadas.push(v);
    if (!e.presente(h)) {
      achados.push({
        verificacao: v,
        severidade: e.severidade,
        titulo: e.titulo,
        recomendacao: e.recomendacao,
      });
    }
  }
  for (const nome of ["Server", "X-Powered-By"]) {
    const v = `versao:${nome.toLowerCase()}`;
    avaliadas.push(v);
    const valor = h.get(nome);
    if (valor && VERSAO.test(valor)) {
      achados.push({
        verificacao: v,
        severidade: "baixa",
        titulo: `Cabeçalho ${nome} revela a versão do software`,
        recomendacao: nome === "Server"
          ? "Esconda a versão (nginx: server_tokens off; Apache: ServerTokens Prod) ou remova o cabeçalho."
          : "Remova o X-Powered-By (PHP: expose_php = Off; Express: app.disable('x-powered-by')).",
        evidencia: `${nome}: ${valor.slice(0, 200)}`,
      });
    }
  }
  avaliadas.push("cors_credenciais");
  if (
    (h.get("access-control-allow-origin") ?? "").trim() === "*" &&
    /^\s*true\s*$/i.test(h.get("access-control-allow-credentials") ?? "")
  ) {
    achados.push({
      verificacao: "cors_credenciais",
      severidade: "media",
      titulo: "CORS aberto (*) com credenciais",
      recomendacao:
        "Não combine Access-Control-Allow-Origin: * com Allow-Credentials: true; liste só as origens do próprio app.",
      evidencia:
        "Access-Control-Allow-Origin: *; Access-Control-Allow-Credentials: true",
    });
  }

  // 4. HTTP → HTTPS (porta 80 fechada não é achado)
  try {
    const r = await c.requisitar(`http://${host}/`, { limiteBytes: 0 });
    avaliadas.push("http_redireciona");
    const loc = r.headers.get("location") ?? "";
    if (!(ehRedirect(r.status) && /^https:\/\//i.test(loc))) {
      achados.push({
        verificacao: "http_redireciona",
        severidade: "media",
        titulo: "HTTP não redireciona para HTTPS",
        recomendacao:
          'Ligue "Always Use HTTPS" no Cloudflare (SSL/TLS → Edge Certificates) ou redirecione com 301 no servidor.',
        evidencia: `HTTP ${r.status}`,
      });
    }
  } catch {
    avaliadas.push("http_redireciona");
  }

  // 5. Arquivos que nunca deveriam ser públicos
  for (const a of ARQUIVOS_SENSIVEIS) {
    const v = `arquivo:${a.caminho}`;
    let r: RespostaHttp;
    try {
      r = await c.requisitar(`https://${host}${a.caminho}`, {
        limiteBytes: LIMITE_ARQUIVO,
      });
    } catch {
      continue; // não avaliado
    }
    avaliadas.push(v);
    if (r.status === 200 && r.corpo.length > 0 && a.assinatura(r.corpo)) {
      achados.push({
        verificacao: v,
        severidade: a.severidade,
        titulo: a.titulo,
        recomendacao: a.recomendacao,
        // Só o fato de existir; nunca o conteúdo.
        evidencia: `HTTP 200 em ${a.caminho} com conteúdo do arquivo`,
      });
    }
  }

  // 6. Supabase REST sem API key
  try {
    const r = await c.requisitar(`https://${host}/rest/v1/`, {
      headers: { Accept: "application/json" },
      limiteBytes: LIMITE_ARQUIVO,
    });
    avaliadas.push("supabase_rest");
    if (r.status === 200 && pareceJsonDoPostgrest(r)) {
      achados.push({
        verificacao: "supabase_rest",
        severidade: "alta",
        titulo: "API REST do Supabase responde sem API key",
        recomendacao:
          "Não exponha o PostgREST sem o gateway do Supabase (Kong): exija apikey e ative RLS em todas as tabelas.",
        evidencia: "HTTP 200 em /rest/v1/ sem apikey",
      });
    }
  } catch {
    // não avaliado
  }

  return res();
}

/** Resposta de bloqueio/desafio do Cloudflare (WAF, regra do próprio Vigia). */
function bloqueioDaBorda(r: RespostaHttp): boolean {
  if (r.status !== 403 && r.status !== 429 && r.status !== 503) return false;
  if (r.headers.has("cf-mitigated")) return true;
  return /Attention Required! \| Cloudflare|Sorry, you have been blocked|Cloudflare Ray ID|Just a moment\.\.\./i
    .test(texto(r.corpo));
}

function pareceJsonDoPostgrest(r: RespostaHttp): boolean {
  const t = texto(r.corpo).trim();
  if (!t || pareceHtml(t)) return false;
  if (!/json/i.test(r.headers.get("content-type") ?? "")) return false;
  if (t.startsWith("[")) return true;
  return /"(swagger|openapi|paths|definitions)"\s*:/.test(t);
}

// ------------------------------------------------------------ cliente real

export interface ClienteDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Relógio em ms (padrão Date.now). */
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
  lerCertificado?: (host: string) => Promise<{ validoAte: Date } | null>;
  timeoutMs?: number;
}

/** Validade do certificado via handshake TLS (node:tls), sem enviar HTTP. */
export function lerCertificadoTls(
  host: string,
  timeoutMs = 10_000,
): Promise<{ validoAte: Date } | null> {
  return new Promise((ok, falha) => {
    const s = tls.connect({
      host,
      port: 443,
      servername: host,
      rejectUnauthorized: false,
    });
    const t = setTimeout(() => {
      s.destroy();
      falha(new Error("timeout TLS"));
    }, timeoutMs);
    s.once("secureConnect", () => {
      clearTimeout(t);
      const c = s.getPeerCertificate();
      s.end();
      const d = c?.valid_to ? new Date(c.valid_to) : null;
      ok(d && Number.isFinite(d.getTime()) ? { validoAte: d } : null);
    });
    s.once("error", (e) => {
      clearTimeout(t);
      falha(e);
    });
  });
}

/** Cliente real: GET/HEAD, UA fixo, sem redirect, ≤ 1 req/s por host. */
export function criarClienteAuditoria(d: ClienteDeps = {}): ClienteAuditoria {
  const f = d.fetch ?? ((u, i) => fetch(u, i));
  const agora = d.agora ?? Date.now;
  const dormir = d.dormir ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lerCert = d.lerCertificado ?? ((h) => lerCertificadoTls(h));
  const timeout = d.timeoutMs ?? 10_000;
  const ultimo = new Map<string, number>();
  // Encadeia as vezes por host para requisições concorrentes não furarem o limite.
  const filas = new Map<string, Promise<unknown>>();

  const naVez = <T>(host: string, fn: () => Promise<T>): Promise<T> => {
    const antes = filas.get(host) ?? Promise.resolve();
    const p = antes.catch(() => {}).then(async () => {
      const u = ultimo.get(host);
      if (u !== undefined) {
        const espera = u + 1000 - agora();
        if (espera > 0) await dormir(espera);
      }
      ultimo.set(host, agora());
      return await fn();
    });
    filas.set(host, p);
    return p;
  };

  return {
    requisitar(url, o = {}) {
      const host = new URL(url).hostname;
      return naVez(host, async () => {
        const r = await f(url, {
          method: o.metodo ?? "GET",
          redirect: "manual",
          headers: { ...(o.headers ?? {}), "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(timeout),
        });
        const corpo = await lerAte(r, o.limiteBytes ?? LIMITE_PAGINA);
        return { status: r.status, headers: r.headers, corpo };
      });
    },
    certificado(host) {
      return naVez(host, () => lerCert(host));
    },
  };
}

async function lerAte(r: Response, limite: number): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array();
  const leitor = r.body.getReader();
  const partes: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < limite) {
      const { done, value } = await leitor.read();
      if (done) break;
      partes.push(value);
      n += value.length;
    }
  } finally {
    leitor.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(n, limite));
  let i = 0;
  for (const p of partes) {
    const parte = p.subarray(0, out.length - i);
    out.set(parte, i);
    i += parte.length;
    if (i >= out.length) break;
  }
  return out;
}
