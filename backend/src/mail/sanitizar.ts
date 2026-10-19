// Sanitização do HTML composto no servidor (allowlist estrita): o que sai
// no e-mail é só formatação simples do editor do PWA. Sem estilo, sem
// imagens, sem url(), links só http(s)/mailto.
// @ts-types="@types/sanitize-html"
import sanitizeHtml from "sanitize-html";

const OPCOES: sanitizeHtml.IOptions = {
  allowedTags: [
    "b",
    "i",
    "u",
    "p",
    "br",
    "ul",
    "ol",
    "li",
    "a",
    "blockquote",
    "div",
    "span",
  ],
  allowedAttributes: { a: ["href"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  allowedStyles: {},
  allowedClasses: {},
  disallowedTagsMode: "discard",
  // o texto destas tags some junto com elas
  nonTextTags: [
    "script",
    "style",
    "textarea",
    "option",
    "noscript",
    "title",
    "head",
    "template",
    "iframe",
    "object",
    "embed",
    "svg",
    "math",
    "select",
    "button",
    "form",
  ],
  // editores (contenteditable) geram strong/em
  transformTags: { strong: "b", em: "i" },
};

/** HTML seguro para o corpo do e-mail. */
export function sanitizarHtml(html: string): string {
  return sanitizeHtml(html, OPCOES);
}

const BR = /<br\s*\/?>/gi;
const BLOCO = /<\/?(p|div|li|blockquote|h[1-6]|tr|ul|ol)(\s[^>]*)?>/gi;
const FIM_BLOCO = "\u0001";

/** Versão texto puro de um HTML (para a parte text/plain). */
export function htmlParaTexto(html: string): string {
  // fronteiras de bloco viram uma quebra só; <br> é sempre uma quebra
  const marcado = html.replace(BR, "\n").replace(BLOCO, `${FIM_BLOCO}$&`);
  const texto = sanitizeHtml(marcado, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: OPCOES.nonTextTags,
  });
  // sanitize-html devolve o texto escapado (& < > ")
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    // deno-lint-ignore no-control-regex
    .replace(/[ \t]*\n*\u0001[\u0001\s]*/g, (m) => {
      const n = m.split("\n").length - 1;
      return "\n".repeat(Math.max(1, n));
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
