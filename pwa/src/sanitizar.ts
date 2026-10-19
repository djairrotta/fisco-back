import DOMPurify from "dompurify";

export interface OpcoesSanitizar {
  /** "carregar imagens": mantém src/srcset/url() remotos (https). */
  permitirRemotas?: boolean;
  /** cid (sem <>) → URL local (blob:/data:) do anexo inline. */
  cids?: Record<string, string>;
  /** Para exibir fora de iframe (prévia da citação): remove <style> e style="". */
  semEstilo?: boolean;
}

export interface Sanitizado {
  html: string;
  /** Quantos recursos remotos foram removidos (mostra "carregar imagens"). */
  bloqueadas: number;
}

const TAGS_PROIBIDAS = [
  "script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "textarea", "select", "option", "base", "meta", "link",
  "video", "audio", "source", "track", "portal", "template", "svg", "math",
];

const ATTR_URL_IMAGEM = ["src", "background", "poster", "lowsrc", "dynsrc"];

/** url(...) em CSS: remoto (http/https/protocolo-relativo/qualquer coisa que não seja data:) */
const CSS_URL = /url\(\s*(['"]?)\s*([^'")]*?)\s*\1\s*\)/gi;
const CSS_IMPORT = /@import\b[^;]*;?/gi;

const ehDataImagem = (u: string) => /^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(u.trim());
const ehRemota = (u: string) => /^(https?:)?\/\//i.test(u.trim());
const ehHttps = (u: string) => /^https:\/\//i.test(u.trim());

/** Limpa CSS: sem @import nunca; url() só data:image, ou https quando permitido. */
/** Declaração com image-set() ou barra invertida (escape que disfarça url/expression): descartada inteira. */
const DECL_SUSPEITA = /[^;{}]*(?:image-set|\\)[^;{}]*;?/gi;

export function limparCss(css: string, permitir: boolean, contar: () => void): string {
  return css
    .replace(CSS_IMPORT, () => { contar(); return ""; })
    .replace(DECL_SUSPEITA, (m) => { if (/image-set/i.test(m)) contar(); return ""; })
    .replace(/expression\s*\(/gi, "(")
    .replace(CSS_URL, (_m, _q, u: string) => {
      if (ehDataImagem(u)) return `url('${u.replace(/['"\\]/g, "")}')`;
      if (permitir && ehHttps(u)) return `url('${u.replace(/'/g, "%27").replace(/"/g, "%22").replace(/\\/g, "%5C")}')`;
      contar();
      return "none";
    });
}

/** Resolve `cid:x` → URL local, ou null. */
function resolverCid(u: string, cids: Record<string, string>): string | null {
  const m = u.trim().match(/^cid:<?([^>]+)>?$/i);
  if (!m) return null;
  let id = m[1];
  try { id = decodeURIComponent(id); } catch { /* usa como veio */ }
  return cids[id] ?? null;
}

/**
 * Sanitiza o HTML de um e-mail recebido (DOMPurify): sem scripts, handlers on*,
 * formulários ou frames; links abrem em nova aba com noopener/noreferrer;
 * imagens/srcset/CSS url() remotos removidos salvo `permitirRemotas`;
 * `cid:` trocado pelo anexo inline.
 */
export function sanitizarEmail(html: string, opc: OpcoesSanitizar = {}): Sanitizado {
  const permitir = !!opc.permitirRemotas;
  const cids = opc.cids ?? {};
  let bloqueadas = 0;
  const contar = () => { bloqueadas++; };
  const purify = DOMPurify(window);

  purify.addHook("uponSanitizeElement", (no, dados) => {
    if (dados.tagName === "style" && no.textContent) {
      no.textContent = limparCss(no.textContent, permitir, contar);
    }
  });

  purify.addHook("afterSanitizeAttributes", (no) => {
    const el = no as Element;
    if (!el.getAttribute) return;
    if (el.tagName === "A" && el.hasAttribute("href")) {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    for (const a of ATTR_URL_IMAGEM) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      const local = resolverCid(v, cids);
      if (local) el.setAttribute(a, local);
      else if (/^cid:/i.test(v.trim())) el.removeAttribute(a);
      else if (ehDataImagem(v)) continue;
      else if (permitir && ehHttps(v)) continue;
      else {
        if (ehRemota(v) || v.trim()) contar();
        el.removeAttribute(a);
      }
    }
    for (const a of ["srcset", "imagesrcset"]) {
      const v = el.getAttribute(a);
      if (v === null) continue;
      const fontes = v.split(",").map((s) => s.trim()).filter(Boolean);
      const ok = permitir && fontes.every((f) => ehHttps(f));
      if (!ok) { contar(); el.removeAttribute(a); }
    }
    const st = el.getAttribute("style");
    if (st !== null) {
      const limpo = limparCss(st, permitir, contar);
      if (limpo.trim()) el.setAttribute("style", limpo); else el.removeAttribute("style");
    }
  });

  const limpo = purify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: opc.semEstilo ? [...TAGS_PROIBIDAS, "style"] : TAGS_PROIBIDAS,
    FORBID_ATTR: ["formaction", "action", "ping", "xlink:href", ...(opc.semEstilo ? ["style", "class", "id"] : [])],
    ADD_ATTR: ["target"],
    ADD_URI_SAFE_ATTR: ["background"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORCE_BODY: true,
  }) as unknown as string;
  return { html: limpo, bloqueadas };
}

const escapar = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Texto puro → HTML seguro (quebra de linha preservada, URLs viram links). */
export function textoParaHtml(texto: string): string {
  const comLinks = escapar(texto).replace(
    /\bhttps?:\/\/[^\s<>"']+/g,
    (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`,
  );
  return `<pre style="white-space:pre-wrap;word-wrap:break-word;font:inherit;margin:0">${comLinks}</pre>`;
}

/**
 * Documento do iframe (srcdoc). A CSP própria só libera imagens data:/blob:,
 * e `https:` após "carregar imagens"; scripts nunca (o sandbox também barra).
 * `tema: "auto"` acompanha o tema do app (só para HTML sem cores próprias);
 * `margem` alinha o texto ao cabeçalho do leitor.
 */
export function documentoIframe(
  corpo: string,
  permitirRemotas: boolean,
  opc: { tema?: "papel" | "auto"; margem?: string } = {},
): string {
  const img = permitirRemotas ? "data: blob: https:" : "data: blob:";
  const csp = `default-src 'none'; img-src ${img}; style-src 'unsafe-inline'; font-src data:`;
  const margem = opc.margem ?? "14px";
  const auto = opc.tema === "auto"
    ? `:root{color-scheme:light dark}@media (prefers-color-scheme:dark){html,body{background:#1e1e20;color:#e6e6e9}a{color:#7ab8ff}blockquote{border-color:#3a3a3e!important;color:#a1a1a7}}`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="referrer" content="no-referrer">` +
    `<base target="_blank">` +
    `<style>html,body{margin:0;padding:0;background:#fff;color:#1d1d1f}` +
    `body{padding:${margem};font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,"Segoe UI",Arial,sans-serif;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}` +
    `p{margin:0 0 .9em}img{max-width:100%;height:auto}table{max-width:100%}a{color:#0a66c2}${auto}</style>` +
    `</head><body>${corpo}</body></html>`;
}

/** cids referenciados no HTML bruto (para buscar só os anexos inline usados). */
export function cidsReferenciados(html: string): string[] {
  const s = new Set<string>();
  for (const m of html.matchAll(/cid:<?([^"'\s)>]+)>?/gi)) {
    try { s.add(decodeURIComponent(m[1])); } catch { s.add(m[1]); }
  }
  return [...s];
}
