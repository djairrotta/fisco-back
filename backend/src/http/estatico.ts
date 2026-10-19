// Serve o PWA do Correio pelo próprio Hono (container único): headers de
// segurança, cache e fallback SPA. Copiado do Vigia (backend/src/http/estatico.ts).
import { type Context, Hono, type MiddlewareHandler } from "@hono/hono";

// CSP do Vigia + `blob:` e `https:` em img-src. O iframe srcdoc do e-mail
// HERDA esta política; ele mesmo restringe as imagens com a sua própria CSP
// (`img-src data: blob:`), e só libera `https:` após "carregar imagens".
export const CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'";

const SEGURANCA: [string, string][] = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "same-origin"],
  [
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  ],
  ["Content-Security-Policy", CSP],
];

const IMUTAVEL = "public, max-age=31536000, immutable";
const SEM_CACHE = "no-cache";

const TIPOS: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  webmanifest: "application/manifest+json",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  map: "application/json",
};

export const DIR_PUBLICO_PADRAO = "/app/public";

function tipoDe(caminho: string): string {
  const ext = caminho.slice(caminho.lastIndexOf(".") + 1).toLowerCase();
  return TIPOS[ext] ?? "application/octet-stream";
}

/** Headers de segurança em TODAS as respostas (API e estático), sem Server. */
export const cabecalhosSeguranca: MiddlewareHandler = async (c, next) => {
  await next();
  const aplicar = (h: Headers) => {
    for (const [k, v] of SEGURANCA) {
      // CSP própria da rota (ex.: anexo com "default-src 'none'; sandbox")
      // é mais restrita: não sobrescrever.
      if (k === "Content-Security-Policy" && h.has(k)) continue;
      h.set(k, v);
    }
    h.delete("Server");
  };
  try {
    aplicar(c.res.headers);
  } catch {
    // Headers imutáveis (resposta de fetch): recria a resposta.
    c.res = new Response(c.res.body, c.res);
    aplicar(c.res.headers);
  }
};

/**
 * Converte o caminho da URL em segmentos seguros, ou null se for suspeito
 * (`..`, barra invertida, NUL, codificação inválida).
 */
function segmentosSeguros(caminhoUrl: string): string[] | null {
  const segs: string[] = [];
  for (const bruto of caminhoUrl.split("/")) {
    if (bruto === "") continue;
    let s: string;
    try {
      s = decodeURIComponent(bruto);
    } catch {
      return null;
    }
    if (
      s === "." || s === ".." || s.includes("/") || s.includes("\\") ||
      s.includes("\0")
    ) {
      return null;
    }
    segs.push(s);
  }
  return segs;
}

interface Arquivo {
  dados: Uint8Array;
  tipo: string;
}

/** Lê o arquivo se existir, for regular e (após resolver symlinks) estiver dentro do dir. */
async function lerDentro(
  raizReal: string,
  segs: string[],
): Promise<Arquivo | null> {
  if (segs.length === 0) return null;
  const alvo = `${raizReal}/${segs.join("/")}`;
  try {
    const real = await Deno.realPath(alvo);
    if (!real.startsWith(raizReal + "/")) return null;
    const st = await Deno.stat(real);
    if (!st.isFile) return null;
    return { dados: await Deno.readFile(real), tipo: tipoDe(real) };
  } catch {
    return null;
  }
}

function responder(c: Context, a: Arquivo, cache: string): Response {
  return c.body(a.dados as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": a.tipo,
    "Cache-Control": cache,
  });
}

function naoEncontrado(c: Context): Response {
  return c.text("Not Found", 404, { "Cache-Control": SEM_CACHE });
}

/**
 * Monta o app raiz: headers de segurança em tudo, a API (`/api/*`, nunca
 * interceptada pelo estático) e, se `dir` existir, o PWA com fallback SPA.
 */
export function montarEstatico(api: Hono, dir: string): Hono {
  const raiz = new Hono();
  raiz.use("*", cabecalhosSeguranca);
  raiz.route("/", api);

  let raizReal: string | null = null;
  try {
    raizReal = Deno.realPathSync(dir);
    if (!Deno.statSync(raizReal).isDirectory) raizReal = null;
  } catch {
    raizReal = null;
  }

  raiz.get("*", async (c) => {
    const p = c.req.path;
    if (raizReal === null || p === "/api" || p.startsWith("/api/")) {
      return naoEncontrado(c);
    }
    const segs = segmentosSeguros(p);
    if (segs === null) return naoEncontrado(c);

    if (segs[0] === "assets") {
      const a = await lerDentro(raizReal, segs);
      return a ? responder(c, a, IMUTAVEL) : naoEncontrado(c);
    }
    const a = await lerDentro(raizReal, segs) ??
      await lerDentro(raizReal, ["index.html"]);
    return a ? responder(c, a, SEM_CACHE) : naoEncontrado(c);
  });
  raiz.notFound((c) => naoEncontrado(c));
  return raiz;
}
