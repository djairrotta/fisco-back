// Varredura de segurança mais profunda dos próprios sites do Djair. Tudo
// não-destrutivo: portas são apenas TCP-connect (fechadas na hora), HTTP é só
// GET sem corpo nem credenciais, segredos vazados são reportados só pelo TIPO.
// Roda na auditoria diária e sob demanda, limitada (≤ 2 req/s por host e um
// orçamento de tempo). Alvo: só hostnames das zonas que o Vigia administra.
import type {
  Achado,
  ClienteAuditoria,
  RespostaHttp,
  ResultadoHost,
  Severidade,
} from "./verificacoes.ts";
import { auditarHost } from "./verificacoes.ts";
import { procurarSegredos } from "./segredos_regex.ts";

const latin1 = new TextDecoder("latin1");
const texto = (b: Uint8Array) => latin1.decode(b);
const pareceHtml = (t: string) =>
  /^\s*(<!doctype\s+html|<html|<head|<body|<!--|<meta|<script)/i.test(t) ||
  /<html[\s>]/i.test(t);

const LIMITE_ARQUIVO = 8192;
const LIMITE_PAGINA = 512 * 1024;
const LIMITE_JS = 2 * 1024 * 1024;
const MAX_JS = 10;
const ORIGEM_TESTE = "https://auditoria.vigia.invalid";

// ------------------------------------------------------------ rede (TCP/TLS)

export interface DetalheTls {
  /** Ex.: "TLSv1.3", "TLSv1.2". */
  protocolo: string | null;
  emissor: string | null;
  validoAte: Date | null;
}

export interface ClienteRede {
  /** IPs (A/AAAA) resolvidos do host. */
  resolver(host: string): Promise<string[]>;
  /** true se a porta TCP aceitou a conexão (fechada logo em seguida). */
  conectar(ip: string, porta: number, timeoutMs: number): Promise<boolean>;
  /** Protocolo, emissor e validade do TLS servido em host:443. */
  tls(host: string): Promise<DetalheTls | null>;
}

/** Portas que deveriam estar atrás do túnel, nunca públicas. */
export const PORTAS_SENSIVEIS: {
  porta: number;
  nome: string;
  severidade: Severidade;
}[] = [
  { porta: 22, nome: "SSH", severidade: "media" },
  { porta: 3306, nome: "MySQL", severidade: "alta" },
  { porta: 5432, nome: "PostgreSQL", severidade: "alta" },
  { porta: 6379, nome: "Redis", severidade: "alta" },
  { porta: 27017, nome: "MongoDB", severidade: "alta" },
  { porta: 9200, nome: "Elasticsearch", severidade: "alta" },
  { porta: 11211, nome: "Memcached", severidade: "alta" },
  { porta: 2375, nome: "Docker API", severidade: "alta" },
  { porta: 8080, nome: "HTTP alternativo", severidade: "media" },
  { porta: 8443, nome: "HTTPS alternativo", severidade: "media" },
];

const TIMEOUT_PORTA_MS = 2000;

/** Número do protocolo TLS (ex.: "TLSv1.2" → 1.2), ou null se desconhecido. */
export function versaoTls(protocolo: string | null): number | null {
  if (!protocolo) return null;
  const m = /TLSv([0-9.]+)/i.exec(protocolo);
  if (m) return Number(m[1]);
  if (/SSLv?[23]/i.test(protocolo)) return 0;
  return null;
}

// ------------------------------------------------------- caminhos expostos

export interface ArquivoExposto {
  caminho: string;
  severidade: Severidade;
  titulo: string;
  recomendacao: string;
  /** true quando o corpo parece o arquivo de verdade (não um index de SPA). */
  assinatura(corpo: Uint8Array, headers: Headers): boolean;
}

const BLOQUEAR =
  "Remova o arquivo do diretório publicado (ou bloqueie o caminho no servidor/Cloudflare) e";
const naoHtml = (b: Uint8Array) => !pareceHtml(texto(b));

export const ARQUIVOS_PROFUNDOS: ArquivoExposto[] = [
  {
    caminho: "/.env.local",
    severidade: "alta",
    titulo: "Arquivo .env.local público",
    recomendacao:
      `${BLOQUEAR} troque as chaves que estavam nele: considere-as vazadas.`,
    assinatura: (b) =>
      naoHtml(b) && /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/m.test(texto(b)),
  },
  {
    caminho: "/config.json",
    severidade: "media",
    titulo: "config.json público com cara de segredo",
    recomendacao:
      `${BLOQUEAR} não publique arquivos de configuração com chaves/segredos na raiz pública.`,
    assinatura: (b) => {
      const t = texto(b);
      if (pareceHtml(t)) return false;
      try {
        JSON.parse(t);
      } catch {
        return false;
      }
      return /"(secret|api[_-]?key|password|token|service_role|private)"/i
        .test(t);
    },
  },
  {
    caminho: "/backup.sql",
    severidade: "alta",
    titulo: "Dump de banco (backup.sql) público",
    recomendacao:
      `${BLOQUEAR} guarde dumps fora da raiz pública; trate os dados e senhas como vazados.`,
    assinatura: (b) =>
      naoHtml(b) &&
      /(CREATE TABLE|INSERT INTO|DROP TABLE|PostgreSQL database dump|MySQL dump)/i
        .test(texto(b)),
  },
  {
    caminho: "/dump.sql",
    severidade: "alta",
    titulo: "Dump de banco (dump.sql) público",
    recomendacao:
      `${BLOQUEAR} guarde dumps fora da raiz pública; trate os dados e senhas como vazados.`,
    assinatura: (b) =>
      naoHtml(b) &&
      /(CREATE TABLE|INSERT INTO|DROP TABLE|PostgreSQL database dump|MySQL dump)/i
        .test(texto(b)),
  },
  {
    caminho: "/.aws/credentials",
    severidade: "alta",
    titulo: "Credenciais da AWS públicas",
    recomendacao:
      `${BLOQUEAR} revogue as chaves da AWS imediatamente: considere-as comprometidas.`,
    assinatura: (b) =>
      naoHtml(b) &&
      /aws_access_key_id|aws_secret_access_key|\[default\]/i.test(texto(b)),
  },
  {
    caminho: "/wp-config.php",
    severidade: "alta",
    titulo: "wp-config.php com código-fonte exposto",
    recomendacao:
      `${BLOQUEAR} o PHP não está sendo executado: o arquivo revela as credenciais do banco. Corrija a execução do PHP e troque as senhas.`,
    assinatura: (b) =>
      naoHtml(b) && /define\(\s*['"]DB_|DB_PASSWORD|wp-settings\.php/i.test(
        texto(b),
      ),
  },
  {
    caminho: "/.svn/",
    severidade: "alta",
    titulo: "Repositório .svn público",
    recomendacao:
      `${BLOQUEAR} não publique a pasta .svn: o código-fonte e o histórico podem ser baixados.`,
    assinatura: (b) => {
      const t = texto(b);
      return /SQLite format 3|dir-prop-base|svn:\/\/|entries|wc\.db/i.test(t) &&
        !/<!doctype\s+html|<html[\s>]/i.test(t);
    },
  },
  {
    caminho: "/storage/logs/laravel.log",
    severidade: "alta",
    titulo: "Log do Laravel público",
    recomendacao:
      `${BLOQUEAR} não publique a pasta storage: os logs revelam caminhos, stack traces e, às vezes, dados.`,
    assinatura: (b) =>
      naoHtml(b) &&
      /\.(ERROR|INFO|DEBUG|WARNING):|Stack trace:|production\.|local\./i.test(
        texto(b),
      ),
  },
  {
    caminho: "/actuator/env",
    severidade: "alta",
    titulo: "Spring Actuator /env público",
    recomendacao:
      "Proteja os endpoints do Spring Boot Actuator (exponha só /health; exija autenticação no resto): /env revela variáveis de ambiente.",
    assinatura: (b) => {
      const t = texto(b);
      return !pareceHtml(t) &&
        /"(activeProfiles|propertySources|systemEnvironment)"/i.test(t);
    },
  },
  {
    caminho: "/debug/pprof/",
    severidade: "media",
    titulo: "Go pprof de depuração público",
    recomendacao:
      "Não exponha /debug/pprof/ na internet: ele permite perfilar o processo e revela memória/goroutines. Sirva-o só em rede interna.",
    assinatura: (b) =>
      /Types of profiles available|\/debug\/pprof\/|full goroutine stack dump/i
        .test(texto(b)),
  },
  {
    caminho: "/metrics",
    severidade: "media",
    titulo: "Métricas Prometheus públicas",
    recomendacao:
      "Restrinja /metrics à rede interna ou exija autenticação: ele revela rotas, versões e volume de tráfego.",
    assinatura: (b) => {
      const t = texto(b);
      return !pareceHtml(t) && /^#\s*(HELP|TYPE)\s+\w/m.test(t);
    },
  },
];

const ehRedirect = (s: number) => s >= 300 && s < 400;

// ----------------------------------------------------------- scripts same-origin

/** URLs de <script src> do mesmo host (https, .js), sem repetir; até `max`. */
export function extrairScripts(
  html: string,
  host: string,
  max = MAX_JS,
): string[] {
  const base = `https://${host}/`;
  const out: string[] = [];
  const vistos = new Set<string>();
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const m of html.matchAll(re)) {
    if (out.length >= max) break;
    let u: URL;
    try {
      u = new URL(m[1], base);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" || u.hostname !== host) continue;
    if (!/\.js$/i.test(u.pathname)) continue;
    const s = u.toString();
    if (vistos.has(s)) continue;
    vistos.add(s);
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------- deep headers

/** Flags de um cookie do Set-Cookie que faltam (Secure/HttpOnly/SameSite). */
export function cookieInseguro(
  setCookie: string,
): { nome: string; falta: string[] } | null {
  const nome = setCookie.split("=")[0]?.trim() ?? "cookie";
  const falta: string[] = [];
  if (!/;\s*secure/i.test(setCookie)) falta.push("Secure");
  if (!/;\s*httponly/i.test(setCookie)) falta.push("HttpOnly");
  if (!/;\s*samesite=/i.test(setCookie)) falta.push("SameSite");
  return falta.length ? { nome, falta } : null;
}

// --------------------------------------------------------------- varredura

export interface OpcoesVarredura {
  /** Máx. de conexões TCP por execução (padrão: todas as portas × 1 IP). */
  maxConexoes?: number;
  /** Orçamento de tempo por host em ms (padrão 60 s). */
  orcamentoMs?: number;
  /** Lista de caminhos extra para enumeração mais agressiva. */
  caminhosExtra?: ArquivoExposto[];
  /** Relógio (padrão Date.now) para o orçamento de tempo. */
  relogio?: () => number;
}

/**
 * Checagens profundas e seguras: portas expostas, protocolo TLS, cabeçalhos
 * adicionais, caminhos expostos, segredos vazados no HTML/JS público e
 * endpoint de auth do Supabase. Devolve achados e as verificações avaliadas.
 */
export async function varreduraProfunda(
  host: string,
  http: ClienteAuditoria,
  rede: ClienteRede,
  agora: Date,
  opts: OpcoesVarredura = {},
): Promise<{ achados: Achado[]; avaliadas: string[] }> {
  const achados: Achado[] = [];
  const avaliadas: string[] = [];
  const relogio = opts.relogio ?? Date.now;
  const t0 = relogio();
  const orcamento = opts.orcamentoMs ?? 60_000;
  const dentroDoOrcamento = () => relogio() - t0 < orcamento;

  // 1. Portas sensíveis (TCP-connect no IP resolvido do próprio host).
  try {
    const ips = await rede.resolver(host);
    if (ips.length) {
      const ip = ips[0]; // só o endereço do próprio host
      const max = opts.maxConexoes ?? PORTAS_SENSIVEIS.length;
      let usadas = 0;
      for (const p of PORTAS_SENSIVEIS) {
        if (usadas >= max || !dentroDoOrcamento()) break;
        usadas++;
        avaliadas.push(`porta:${p.porta}`);
        let aberta = false;
        try {
          aberta = await rede.conectar(ip, p.porta, TIMEOUT_PORTA_MS);
        } catch {
          avaliadas.pop(); // não avaliada de fato
          continue;
        }
        if (aberta) {
          achados.push({
            verificacao: `porta:${p.porta}`,
            severidade: p.severidade,
            titulo: `Porta ${p.porta} (${p.nome}) exposta na internet`,
            recomendacao:
              `Feche a porta ${p.porta} para a internet: deixe o serviço só atrás do túnel/rede interna (firewall ou binding em 127.0.0.1).`,
            evidencia: `TCP ${p.porta} aceitou conexão`,
          });
        }
      }
    }
  } catch {
    // DNS falhou: portas não avaliadas
  }

  // 2. Protocolo TLS (< 1.2 é achado; validade fica na verificação antiga).
  try {
    const tls = await rede.tls(host);
    if (tls) {
      avaliadas.push("tls_protocolo");
      const v = versaoTls(tls.protocolo);
      if (v !== null && v < 1.2) {
        achados.push({
          verificacao: "tls_protocolo",
          severidade: v <= 1.0 ? "alta" : "media",
          titulo: `TLS antigo em uso (${tls.protocolo ?? "desconhecido"})`,
          recomendacao:
            "Exija TLS 1.2+ (Cloudflare → SSL/TLS → Edge Certificates → Minimum TLS Version 1.2; na origem, desative TLS 1.0/1.1).",
          evidencia: `protocolo ${tls.protocolo}`,
        });
      }
    }
  } catch {
    // TLS ilegível: não avaliado
  }

  // Página inicial (uma vez) para cabeçalhos profundos e segredos.
  let pagina: RespostaHttp | null = null;
  try {
    pagina = await paginaInicial(host, http);
  } catch {
    pagina = null;
  }

  // 3. Cabeçalhos profundos: Permissions-Policy e cookies inseguros.
  if (pagina && !bloqueioDaBorda(pagina)) {
    const h = pagina.headers;
    avaliadas.push("cabecalho:permissions-policy");
    if ((h.get("permissions-policy") ?? "").trim() === "") {
      achados.push({
        verificacao: "cabecalho:permissions-policy",
        severidade: "baixa",
        titulo: "Falta o cabeçalho Permissions-Policy",
        recomendacao:
          "Envie Permissions-Policy desligando recursos que o app não usa (ex.: geolocation=(), camera=(), microphone=()).",
      });
    }
    avaliadas.push("cookie:inseguro");
    const sc = h.get("set-cookie");
    const ins = sc ? cookieInseguro(sc) : null;
    if (ins) {
      achados.push({
        verificacao: "cookie:inseguro",
        severidade: "media",
        titulo: `Cookie sem ${ins.falta.join("/")}`,
        recomendacao:
          "Marque os cookies como Secure, HttpOnly e SameSite (Lax ou Strict) para reduzir roubo de sessão e CSRF.",
        evidencia: `cookie ${ins.nome}: falta ${ins.falta.join(", ")}`,
      });
    }
  }

  // 4. Caminhos expostos (lista profunda + extra de enumeração).
  const lista = [...ARQUIVOS_PROFUNDOS, ...(opts.caminhosExtra ?? [])];
  for (const a of lista) {
    if (!dentroDoOrcamento()) break;
    let r: RespostaHttp;
    try {
      r = await http.requisitar(`https://${host}${a.caminho}`, {
        limiteBytes: LIMITE_ARQUIVO,
      });
    } catch {
      continue; // não avaliado
    }
    avaliadas.push(`exposto:${a.caminho}`);
    if (
      r.status === 200 && r.corpo.length > 0 && a.assinatura(r.corpo, r.headers)
    ) {
      achados.push({
        verificacao: `exposto:${a.caminho}`,
        severidade: a.severidade,
        titulo: a.titulo,
        recomendacao: a.recomendacao,
        evidencia: `HTTP 200 em ${a.caminho} com conteúdo do arquivo`,
      });
    }
  }

  // 5. security.txt: a AUSÊNCIA é uma sugestão de baixa severidade.
  try {
    const r = await http.requisitar(
      `https://${host}/.well-known/security.txt`,
      { limiteBytes: LIMITE_ARQUIVO },
    );
    avaliadas.push("exposto:/.well-known/security.txt");
    const ok = r.status === 200 && /contact:/i.test(texto(r.corpo));
    if (!ok) {
      achados.push({
        verificacao: "exposto:/.well-known/security.txt",
        severidade: "baixa",
        titulo: "Sem /.well-known/security.txt",
        recomendacao:
          "Publique um /.well-known/security.txt com um contato de segurança (RFC 9116) para facilitar relatos responsáveis de vulnerabilidade.",
      });
    }
  } catch {
    // não avaliado
  }

  // 6. Segredos vazados no HTML e nos bundles .js do mesmo host.
  if (pagina && !bloqueioDaBorda(pagina) && dentroDoOrcamento()) {
    avaliadas.push("segredo_publico");
    const vazados: { tipo: string; sev: Severidade; onde: string }[] = [];
    const varrer = (corpo: Uint8Array, arquivo: string) => {
      for (const s of procurarSegredos(texto(corpo))) {
        vazados.push({
          tipo: s.tipo,
          sev: s.severidade,
          onde: `${arquivo} (${s.mascara})`,
        });
      }
    };
    varrer(pagina.corpo, "/");
    const scripts = extrairScripts(texto(pagina.corpo), host);
    for (const url of scripts) {
      if (!dentroDoOrcamento()) break;
      try {
        const r = await http.requisitar(url, { limiteBytes: LIMITE_JS });
        if (r.status === 200) varrer(r.corpo, new URL(url).pathname);
      } catch {
        // ignora o bundle que falhou
      }
    }
    if (vazados.length) {
      const sev: Severidade = vazados.some((v) => v.sev === "alta")
        ? "alta"
        : "media";
      const tipos = [...new Set(vazados.map((v) => v.tipo))];
      achados.push({
        verificacao: "segredo_publico",
        severidade: sev,
        titulo: `Segredo exposto no código público (${tipos.length} tipo(s))`,
        recomendacao:
          "Tire o segredo do frontend: mova a chave para o servidor e troque-a (considere-a vazada). Se for anon key pública do Supabase, tudo bem; service_role e chaves de servidor, nunca.",
        evidencia: vazados.slice(0, 10).map((v) => `${v.tipo}: ${v.onde}`).join(
          "; ",
        ),
      });
    }
  }

  // 7. Supabase: endpoint de auth (GoTrue) alcançável sem gateway.
  try {
    const r = await http.requisitar(`https://${host}/auth/v1/signup`, {
      headers: { Accept: "application/json" },
      limiteBytes: LIMITE_ARQUIVO,
    });
    avaliadas.push("supabase_auth");
    if (respostaGoTrue(r)) {
      achados.push({
        verificacao: "supabase_auth",
        severidade: "media",
        titulo: "Endpoint de auth do Supabase (GoTrue) exposto",
        recomendacao:
          "Não exponha /auth/v1 direto: use o gateway do Supabase (Kong) e, se o cadastro aberto não for necessário, desligue signups (Authentication → Providers).",
        evidencia: "GoTrue respondeu em /auth/v1/signup",
      });
    }
  } catch {
    // não avaliado
  }

  return { achados, avaliadas };
}

/**
 * Auditoria completa de um host: as checagens básicas (auditarHost) mais a
 * varredura profunda. Se a borda do Cloudflare barrou, nada é avaliado (igual
 * à auditoria básica). Falha na varredura profunda não derruba o resultado
 * básico. É isto que a execução diária e o "rodar agora" usam.
 */
export async function auditarHostProfundo(
  host: string,
  http: ClienteAuditoria,
  rede: ClienteRede,
  agora: Date,
  opts: OpcoesVarredura = {},
): Promise<ResultadoHost> {
  const base = await auditarHost(host, http, agora);
  if (base.bloqueadoNaBorda) return base;
  try {
    const extra = await varreduraProfunda(host, http, rede, agora, opts);
    return {
      host: base.host,
      bloqueadoNaBorda: base.bloqueadoNaBorda,
      achados: [...base.achados, ...extra.achados],
      avaliadas: [...base.avaliadas, ...extra.avaliadas],
    };
  } catch {
    return base;
  }
}

/** Resposta com cara do GoTrue (JSON com msg/error_code/code), não SPA/CF. */
function respostaGoTrue(r: RespostaHttp): boolean {
  if (bloqueioDaBorda(r)) return false;
  const ct = r.headers.get("content-type") ?? "";
  if (!/json/i.test(ct)) return false;
  const t = texto(r.corpo).trim();
  if (!t || pareceHtml(t)) return false;
  return /"(msg|error_code|code|error_description|error)"\s*:/.test(t);
}

/** Resposta de bloqueio/desafio do Cloudflare. */
function bloqueioDaBorda(r: RespostaHttp): boolean {
  if (r.status !== 403 && r.status !== 429 && r.status !== 503) return false;
  if (r.headers.has("cf-mitigated")) return true;
  return /Attention Required! \| Cloudflare|Sorry, you have been blocked|Cloudflare Ray ID|Just a moment\.\.\./i
    .test(texto(r.corpo));
}

/** GET na home seguindo redirecionamento só dentro do mesmo host (HTTPS). */
async function paginaInicial(
  host: string,
  http: ClienteAuditoria,
): Promise<RespostaHttp> {
  let url = `https://${host}/`;
  let r = await http.requisitar(url, {
    headers: { Origin: ORIGEM_TESTE },
    limiteBytes: LIMITE_PAGINA,
  });
  for (let i = 0; i < 3 && ehRedirect(r.status); i++) {
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
    r = await http.requisitar(url, {
      headers: { Origin: ORIGEM_TESTE },
      limiteBytes: LIMITE_PAGINA,
    });
  }
  return r;
}

// ------------------------------------------------------------ cliente real

/** Cliente de rede real: DNS (Deno.resolveDns), TCP-connect e TLS (node:tls). */
export function criarClienteRede(d: {
  resolver?: (host: string) => Promise<string[]>;
  conectar?: (ip: string, porta: number, timeoutMs: number) => Promise<boolean>;
  tls?: (host: string) => Promise<DetalheTls | null>;
} = {}): ClienteRede {
  return {
    resolver: d.resolver ?? (async (host) => {
      const ips: string[] = [];
      for (const tipo of ["A", "AAAA"] as const) {
        try {
          ips.push(...await Deno.resolveDns(host, tipo));
        } catch {
          // sem registro desse tipo
        }
      }
      return ips;
    }),
    conectar: d.conectar ??
      ((ip, porta, timeoutMs) => conectarTcp(ip, porta, timeoutMs)),
    tls: d.tls ?? ((host) => lerTls(host)),
  };
}

/** TCP-connect com timeout; fecha a conexão na hora. Nunca envia dados. */
async function conectarTcp(
  ip: string,
  porta: number,
  timeoutMs: number,
): Promise<boolean> {
  const connP = Deno.connect({ hostname: ip, port: porta });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), timeoutMs);
  });
  try {
    const r = await Promise.race([connP, timeoutP]);
    if (r === null) {
      connP.then((c) => {
        try {
          c.close();
        } catch { /* ignora */ }
      }).catch(() => {});
      return false;
    }
    try {
      (r as Deno.TcpConn).close();
    } catch { /* ignora */ }
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Handshake TLS (node:tls) só para ler protocolo, emissor e validade. */
function lerTls(host: string, timeoutMs = 10_000): Promise<DetalheTls | null> {
  return import("node:tls").then(({ default: tls }) =>
    new Promise<DetalheTls | null>((ok) => {
      const s = tls.connect({
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
      });
      const t = setTimeout(() => {
        s.destroy();
        ok(null);
      }, timeoutMs);
      s.once("secureConnect", () => {
        clearTimeout(t);
        const c = s.getPeerCertificate();
        const protocolo = s.getProtocol();
        s.end();
        const d = c?.valid_to ? new Date(c.valid_to) : null;
        ok({
          protocolo: protocolo ?? null,
          emissor: c?.issuer?.O ?? c?.issuer?.CN ?? null,
          validoAte: d && Number.isFinite(d.getTime()) ? d : null,
        });
      });
      s.once("error", () => {
        clearTimeout(t);
        ok(null);
      });
    })
  ).catch(() => null);
}
