// Estúdio de assinatura (2.0): quatro modelos em tabela, com estilos inline,
// pensados para Gmail, Outlook e Apple Mail. Nada do usuário entra cru:
// todo campo é escapado; links só http(s); mailto:, tel: e wa.me são
// montados aqui a partir de e-mail/dígitos validados. Ícones de redes não
// são usados (sem hospedagem externa): as redes saem como links de texto.
import { escaparHtml } from "./assinatura.ts";

export const MODELOS = [
  "classico",
  "executivo",
  "moderno",
  "minimalista",
] as const;
export type Modelo = typeof MODELOS[number];

export const NOMES_MODELO: Record<Modelo, string> = {
  classico: "Clássico",
  executivo: "Executivo",
  moderno: "Moderno",
  minimalista: "Minimalista",
};

export const ORIGENS_LOGO = ["caixa", "propria", "nenhum"] as const;
export type OrigemLogo = typeof ORIGENS_LOGO[number];
export const DIVISORES = ["linha", "nenhum", "barra"] as const;
export type Divisor = typeof DIVISORES[number];

export const REDES = [
  "linkedin",
  "instagram",
  "facebook",
  "x",
  "youtube",
] as const;
export type Rede = typeof REDES[number];
const NOME_REDE: Record<Rede, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
  youtube: "YouTube",
};

export interface CamposAssinatura2 {
  nome?: string;
  cargo?: string;
  empresa?: string;
  /** Ex.: "OAB/SP 341.378". */
  registro?: string;
  telefone?: string;
  whatsapp?: string;
  email?: string;
  site?: string;
  endereco?: string;
  redes?: Partial<Record<Rede, string>>;
  /** Aviso de confidencialidade; "" = sem aviso. */
  aviso?: string;
  /** Padrão "caixa" (logo da caixa, se houver). */
  logo?: OrigemLogo;
  /** #rrggbb; ausente → cor da caixa ou COR_PADRAO. */
  corDestaque?: string;
  /** Padrão "linha". */
  divisor?: Divisor;
}

/** Texto padrão do aviso (editável pelo usuário). */
export const AVISO_PADRAO =
  "AVISO DE CONFIDENCIALIDADE: esta mensagem e seus anexos podem conter " +
  "informações confidenciais ou protegidas por sigilo profissional (art. 7º, " +
  "II, da Lei nº 8.906/1994 – Estatuto da Advocacia e da OAB) e destinam-se " +
  "exclusivamente ao(s) destinatário(s) indicado(s). Se você a recebeu por " +
  "engano, informe imediatamente o remetente e apague-a; é vedado o uso, a " +
  "cópia, a divulgação ou a distribuição do seu conteúdo. Os dados pessoais " +
  "aqui tratados observam a Lei nº 13.709/2018 (LGPD).";

export const COR_PADRAO = "#1f3a5f";
/** CID do logo da assinatura (anexo inline no envio). */
export const CID_LOGO_ASSINATURA = "logo-assinatura@correio";

export interface AnexoInline {
  cid: string;
  nome: string;
  mime: string;
  bytes: Uint8Array;
}

export interface AssinaturaGerada {
  html: string;
  texto: string;
  anexosInline: AnexoInline[];
}

export interface OpcoesGeracao {
  /** Bytes do logo já resolvido (caixa ou próprio); null/ausente = sem logo. */
  logo?: { bytes: Uint8Array; mime: string } | null;
  /** "cid" (envio, padrão) ou "dataUri" (prévia e download .html). */
  imagens?: "cid" | "dataUri";
  /** Cor usada quando corDestaque falta (ex.: a cor da caixa). */
  corPadrao?: string | null;
}

// ------------------------------------------------------------ validação

const COR = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@<>"'()\[\]\\,;:]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const DOMINIO_SEM_ESQUEMA =
  /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?([/?#].*)?$/;
const ESQUEMA = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * URL http(s) absoluta (normalizada) ou null. "www.x.com.br" vira
 * "https://www.x.com.br/"; qualquer outro esquema (javascript:, data:…) é
 * recusado.
 */
export function urlSegura(s: string | undefined): string | null {
  let v = s?.trim();
  // deno-lint-ignore no-control-regex
  if (!v || /[\s\x00-\x1f\x7f<>"]/.test(v)) return null;
  if (!ESQUEMA.test(v)) {
    if (v.startsWith("//") || !DOMINIO_SEM_ESQUEMA.test(v)) return null;
    v = `https://${v}`;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function emailSeguro(s: string | undefined): string | null {
  const v = s?.trim();
  return v && v.length <= 254 && EMAIL.test(v) ? v : null;
}

/** tel:+5519… a partir dos dígitos (8 a 15); null se não parece telefone. */
export function hrefTelefone(s: string | undefined): string | null {
  const v = s?.trim() ?? "";
  const d = v.replace(/\D/g, "");
  if (d.length < 8 || d.length > 15) return null;
  return `tel:${v.startsWith("+") ? "+" : ""}${d}`;
}

/** https://wa.me/<dígitos>; sem "+", número de 10–11 dígitos ganha o DDI 55. */
export function hrefWhatsapp(s: string | undefined): string | null {
  const v = (s ?? "").trim();
  let d = v.replace(/\D/g, "");
  if (!v.startsWith("+") && (d.length === 10 || d.length === 11)) d = `55${d}`;
  if (d.length < 10 || d.length > 15) return null;
  return `https://wa.me/${d}`;
}

export function corValida(s: string | undefined | null): string | null {
  return s && COR.test(s) ? s.toLowerCase() : null;
}

// ------------------------------------------------------------ dados comuns

interface Contato {
  rotulo: string;
  curto: string;
  texto: string;
  href: string | null;
}

interface Dados {
  nome: string | null;
  cargo: string | null;
  empresa: string | null;
  registro: string | null;
  endereco: string | null;
  contatos: Contato[];
  redes: { nome: string; href: string }[];
  aviso: string | null;
  cor: string;
  divisor: Divisor;
  logoSrc: string | null;
}

const t = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() || null;

function exibirUrl(u: string): string {
  return u.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const MIMES_LOGO = new Set(["image/png", "image/jpeg", "image/webp"]);

function dados(
  c: CamposAssinatura2,
  o: OpcoesGeracao,
): { d: Dados; textoLinhas: string[]; inline: AnexoInline[] } {
  const contatos: Contato[] = [];
  const tel = t(c.telefone);
  if (tel) {
    contatos.push({
      rotulo: "Telefone",
      curto: "T",
      texto: tel,
      href: hrefTelefone(tel),
    });
  }
  const wa = t(c.whatsapp);
  if (wa) {
    contatos.push({
      rotulo: "WhatsApp",
      curto: "W",
      texto: wa,
      href: hrefWhatsapp(wa),
    });
  }
  const email = emailSeguro(c.email);
  if (email) {
    contatos.push({
      rotulo: "E-mail",
      curto: "E",
      texto: email,
      href: `mailto:${email}`,
    });
  }
  const site = urlSegura(c.site);
  if (site) {
    contatos.push({
      rotulo: "Site",
      curto: "S",
      texto: exibirUrl(site),
      href: site,
    });
  }
  const redes: { nome: string; href: string }[] = [];
  for (const r of REDES) {
    const u = urlSegura(c.redes?.[r]);
    if (u) redes.push({ nome: NOME_REDE[r], href: u });
  }

  const aviso = c.aviso?.replace(/\r\n?/g, "\n").trim() || null;
  const inline: AnexoInline[] = [];
  let logoSrc: string | null = null;
  if (c.logo !== "nenhum" && o.logo && MIMES_LOGO.has(o.logo.mime)) {
    if (o.imagens === "dataUri") {
      logoSrc = `data:${o.logo.mime};base64,${base64(o.logo.bytes)}`;
    } else {
      logoSrc = `cid:${CID_LOGO_ASSINATURA}`;
      inline.push({
        cid: CID_LOGO_ASSINATURA,
        nome: `logo.${o.logo.mime.split("/")[1].replace("jpeg", "jpg")}`,
        mime: o.logo.mime,
        bytes: o.logo.bytes,
      });
    }
  }

  const d: Dados = {
    nome: t(c.nome),
    cargo: t(c.cargo),
    empresa: t(c.empresa),
    registro: t(c.registro),
    endereco: t(c.endereco),
    contatos,
    redes,
    aviso,
    cor: corValida(c.corDestaque) ?? corValida(o.corPadrao) ?? COR_PADRAO,
    divisor: c.divisor && DIVISORES.includes(c.divisor) ? c.divisor : "linha",
    logoSrc,
  };

  const linhas: string[] = [];
  if (d.nome) linhas.push(d.nome);
  const ce = [d.cargo, d.empresa].filter(Boolean).join(" — ");
  if (ce) linhas.push(ce);
  if (d.registro) linhas.push(d.registro);
  for (const x of contatos) {
    linhas.push(
      `${x.rotulo}: ${x.href?.startsWith("http") ? x.href : x.texto}`,
    );
  }
  if (d.endereco) linhas.push(d.endereco);
  for (const r of redes) linhas.push(`${r.nome}: ${r.href}`);
  if (aviso && linhas.length) linhas.push("", aviso);
  return { d, textoLinhas: linhas, inline };
}

// ------------------------------------------------------------ peças HTML

const SERIFA = "Georgia,'Times New Roman',Times,serif";
const SANS = "Helvetica,Arial,sans-serif";
const TEXTO = "#2b2b2b";
const SUAVE = "#6b6b6b";
const FILETE = "#d9d9d9";

const e = escaparHtml;

function link(href: string | null, texto: string, cor: string): string {
  if (!href) return e(texto);
  return `<a href="${e(href)}" style="color:${cor};text-decoration:none;">${
    e(texto)
  }</a>`;
}

function img(src: string, largura: number): string {
  return `<img src="${
    e(src)
  }" alt="" width="${largura}" style="display:block;border:0;outline:none;width:${largura}px;max-width:${largura}px;height:auto;">`;
}

/** Linha horizontal fina (tabela: o Outlook ignora margin em <hr>). */
function filete(cor = FILETE, espaco = 10): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td style="height:${espaco}px;font-size:0;line-height:0;">&nbsp;</td></tr><tr><td style="border-top:1px solid ${cor};height:${espaco}px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

/** Barra vertical de destaque entre o logo e o texto. */
function barraVertical(cor: string, largura = 2): string {
  return `<td width="${largura}" style="width:${largura}px;background-color:${cor};font-size:0;line-height:0;">&nbsp;</td><td width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td>`;
}

function div(estilo: string, conteudo: string): string {
  return `<div style="${estilo}">${conteudo}</div>`;
}

function blocoAviso(d: Dados): string {
  if (!d.aviso) return "";
  return `<tr><td style="padding-top:14px;font-family:${SANS};font-size:10px;line-height:1.5;color:#8a8a8a;max-width:560px;">${
    e(d.aviso).replace(/\n/g, "<br>")
  }</td></tr>`;
}

function envolver(d: Dados, principal: string, fonte: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:${fonte};color:${TEXTO};"><tr><td>${principal}</td></tr>${
    blocoAviso(d)
  }</table>`;
}

function tabela(celulas: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${celulas}</tr></table>`;
}

const SEP = "&nbsp;&nbsp;·&nbsp;&nbsp;";

function redesHtml(d: Dados, estilo = "", sep = SEP): string {
  return d.redes.map((r) =>
    `<a href="${
      e(r.href)
    }" style="color:${d.cor};text-decoration:none;${estilo}">${e(r.nome)}</a>`
  ).join(sep);
}

// ------------------------------------------------------------ modelos

function classico(d: Dados): string {
  const texto: string[] = [];
  if (d.nome) {
    texto.push(div(
      `font-family:${SERIFA};font-size:18px;line-height:1.3;font-weight:bold;color:${d.cor};`,
      e(d.nome),
    ));
  }
  if (d.cargo) {
    texto.push(div(
      `font-family:${SERIFA};font-size:13px;line-height:1.4;font-style:italic;color:${SUAVE};`,
      e(d.cargo),
    ));
  }
  if (d.empresa) {
    texto.push(div(
      `font-family:${SANS};font-size:11px;line-height:1.6;letter-spacing:1.5px;text-transform:uppercase;color:${TEXTO};padding-top:2px;`,
      e(d.empresa),
    ));
  }
  if (d.registro) {
    texto.push(div(
      `font-family:${SERIFA};font-size:12px;line-height:1.4;color:${SUAVE};`,
      e(d.registro),
    ));
  }
  const resto: string[] = [];
  if (d.contatos.length) {
    resto.push(div(
      `font-family:${SERIFA};font-size:12px;line-height:1.7;color:${TEXTO};`,
      d.contatos.map((c) =>
        `<span style="color:${d.cor};font-weight:bold;">${c.curto}</span>&nbsp;${
          link(c.href, c.texto, TEXTO)
        }`
      ).join(SEP),
    ));
  }
  if (d.endereco) {
    resto.push(div(
      `font-family:${SERIFA};font-size:12px;line-height:1.5;color:${SUAVE};`,
      e(d.endereco),
    ));
  }
  if (d.redes.length) {
    resto.push(div(
      `font-family:${SANS};font-size:11px;line-height:1.8;letter-spacing:.5px;`,
      redesHtml(d),
    ));
  }
  const corpo = texto.join("") +
    (resto.length && texto.length
      ? d.divisor === "linha"
        ? filete()
        : `<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>`
      : "") +
    resto.join("");
  const celulas =
    (d.logoSrc
      ? `<td valign="top" style="vertical-align:top;padding-right:${
        d.divisor === "barra" ? 14 : 18
      }px;">${img(d.logoSrc, 88)}</td>`
      : "") +
    (d.divisor === "barra" ? barraVertical(d.cor) : "") +
    `<td valign="top" style="vertical-align:top;">${corpo}</td>`;
  return envolver(d, tabela(celulas), SERIFA);
}

function executivo(d: Dados): string {
  const partes: string[] = [];
  if (d.logoSrc) {
    partes.push(
      `<div style="padding-bottom:12px;">${img(d.logoSrc, 64)}</div>`,
    );
  }
  if (d.nome) {
    partes.push(div(
      `font-family:${SANS};font-size:15px;line-height:1.3;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:#111111;`,
      e(d.nome),
    ));
  }
  const ce = [d.cargo, d.empresa].filter((x): x is string => !!x);
  if (ce.length) {
    partes.push(div(
      `font-family:${SANS};font-size:12px;line-height:1.5;color:${SUAVE};`,
      ce.map((x, i) =>
        i === 1 ? `<span style="color:${d.cor};">${e(x)}</span>` : e(x)
      ).join("&nbsp;&nbsp;|&nbsp;&nbsp;"),
    ));
  }
  if (d.registro) {
    partes.push(div(
      `font-family:${SANS};font-size:11px;line-height:1.5;color:${SUAVE};letter-spacing:.3px;`,
      e(d.registro),
    ));
  }
  if (d.divisor === "barra") {
    partes.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td style="height:10px;font-size:0;line-height:0;">&nbsp;</td></tr><tr><td width="48" style="width:48px;height:3px;background-color:${d.cor};font-size:0;line-height:0;">&nbsp;</td></tr><tr><td style="height:10px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`,
    );
  } else if (d.divisor === "linha") partes.push(filete());
  else {partes.push(
      `<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>`,
    );}
  if (d.contatos.length) {
    const linhas = d.contatos.map((c) =>
      `<tr><td style="font-family:${SANS};font-size:11px;line-height:1.7;color:${d.cor};text-transform:uppercase;letter-spacing:.8px;padding-right:12px;white-space:nowrap;">${
        e(c.rotulo)
      }</td><td style="font-family:${SANS};font-size:12px;line-height:1.7;color:${TEXTO};">${
        link(c.href, c.texto, TEXTO)
      }</td></tr>`
    ).join("");
    partes.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${linhas}</table>`,
    );
  }
  if (d.endereco) {
    partes.push(div(
      `font-family:${SANS};font-size:12px;line-height:1.6;color:${SUAVE};padding-top:2px;`,
      e(d.endereco),
    ));
  }
  if (d.redes.length) {
    partes.push(div(
      `font-family:${SANS};font-size:11px;line-height:1.8;padding-top:4px;font-weight:bold;`,
      redesHtml(d),
    ));
  }
  return envolver(d, partes.join(""), SANS);
}

function moderno(d: Dados): string {
  const texto: string[] = [];
  if (d.nome) {
    texto.push(div(
      `font-family:${SANS};font-size:19px;line-height:1.25;font-weight:bold;color:#111111;letter-spacing:-.2px;`,
      e(d.nome),
    ));
  }
  if (d.cargo) {
    texto.push(div(
      `font-family:${SANS};font-size:13px;line-height:1.5;font-weight:bold;color:${d.cor};`,
      e(d.cargo),
    ));
  }
  const er = [d.empresa, d.registro].filter((x): x is string => !!x);
  if (er.length) {
    texto.push(div(
      `font-family:${SANS};font-size:12px;line-height:1.5;color:${SUAVE};`,
      er.map(e).join(SEP),
    ));
  }
  const resto: string[] = [];
  if (d.contatos.length) {
    resto.push(div(
      `font-family:${SANS};font-size:12px;line-height:1.7;color:${TEXTO};`,
      d.contatos.map((c) => link(c.href, c.texto, TEXTO)).join(
        `&nbsp;&nbsp;<span style="color:${d.cor};">|</span>&nbsp;&nbsp;`,
      ),
    ));
  }
  if (d.endereco) {
    resto.push(div(
      `font-family:${SANS};font-size:12px;line-height:1.5;color:${SUAVE};`,
      e(d.endereco),
    ));
  }
  if (d.redes.length) {
    resto.push(div(
      `font-family:${SANS};font-size:10px;line-height:2;letter-spacing:1.4px;text-transform:uppercase;font-weight:bold;padding-top:2px;`,
      redesHtml(d, "", "&nbsp;&nbsp;&nbsp;&nbsp;"),
    ));
  }
  const corpo = texto.join("") +
    (resto.length && d.divisor === "linha" && texto.length
      ? filete(d.cor, 8)
      : resto.length && texto.length
      ? `<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>`
      : "") +
    resto.join("");
  const celulas = (d.divisor === "barra" ? barraVertical(d.cor, 4) : "") +
    (d.logoSrc
      ? `<td valign="top" style="vertical-align:top;padding-right:16px;">${
        img(d.logoSrc, 72)
      }</td>`
      : "") +
    `<td valign="top" style="vertical-align:top;">${corpo}</td>`;
  return envolver(d, tabela(celulas), SANS);
}

function minimalista(d: Dados): string {
  const partes: string[] = [];
  const topo: string[] = [];
  if (d.nome) {
    topo.push(
      `<span style="font-family:${SANS};font-size:14px;font-weight:bold;color:#111111;">${
        e(d.nome)
      }</span>`,
    );
  }
  const ce = [d.cargo, d.empresa, d.registro].filter((x): x is string => !!x);
  if (ce.length) {
    topo.push(
      `<span style="font-family:${SANS};font-size:12px;color:${SUAVE};">${
        ce.map(e).join(", ")
      }</span>`,
    );
  }
  if (topo.length) {
    partes.push(div(
      "line-height:1.5;",
      topo.join(
        `<span style="color:${d.cor};">&nbsp;&nbsp;/&nbsp;&nbsp;</span>`,
      ),
    ));
  }
  const baixo = [
    ...d.contatos.map((c) => link(c.href, c.texto, SUAVE)),
    ...(d.endereco ? [e(d.endereco)] : []),
  ];
  if (baixo.length || d.redes.length) {
    if (partes.length && d.divisor === "linha") partes.push(filete(FILETE, 6));
    if (baixo.length) {
      partes.push(div(
        `font-family:${SANS};font-size:11px;line-height:1.7;color:${SUAVE};`,
        baixo.join(SEP),
      ));
    }
    if (d.redes.length) {
      partes.push(div(
        `font-family:${SANS};font-size:11px;line-height:1.7;`,
        redesHtml(d),
      ));
    }
  }
  const corpo = partes.join("");
  const celulas =
    (d.logoSrc
      ? `<td valign="middle" style="vertical-align:middle;padding-right:12px;">${
        img(d.logoSrc, 44)
      }</td>`
      : "") +
    (d.divisor === "barra" ? barraVertical(d.cor, 1) : "") +
    `<td valign="middle" style="vertical-align:middle;">${corpo}</td>`;
  return envolver(d, tabela(celulas), SANS);
}

const GERADORES: Record<Modelo, (d: Dados) => string> = {
  classico,
  executivo,
  moderno,
  minimalista,
};

/**
 * Gera a assinatura do `modelo`. Sem nenhum campo visível (nem nome, nem
 * contato…) → vazia: {html:"", texto:"", anexosInline:[]}. O logo só entra
 * se `opc.logo` vier (a origem — caixa ou próprio — é resolvida por quem
 * chama) e `campos.logo` não for "nenhum".
 */
export function gerarAssinaturaModelo(
  modelo: Modelo,
  campos: CamposAssinatura2,
  opc: OpcoesGeracao = {},
): AssinaturaGerada {
  const { d, textoLinhas, inline } = dados(campos, opc);
  const temConteudo = !!(d.nome || d.cargo || d.empresa || d.registro ||
    d.endereco || d.contatos.length || d.redes.length);
  if (!temConteudo) return { html: "", texto: "", anexosInline: [] };
  const gerar = GERADORES[modelo] ?? classico;
  return {
    html: gerar(d),
    texto: textoLinhas.join("\n"),
    anexosInline: inline,
  };
}

/** Documento .html completo para download (imagens embutidas em data:). */
export function documentoAssinatura(titulo: string, html: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(titulo)}</title>
</head>
<body style="margin:0;padding:24px;background:#ffffff;">
${html}
</body>
</html>
`;
}
