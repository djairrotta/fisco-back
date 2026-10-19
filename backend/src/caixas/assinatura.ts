// Assinatura gerada de um modelo fixo em tabela (compatível com clientes de
// e-mail). Nenhum HTML do usuário entra cru: todo campo é escapado.

export interface CamposAssinatura {
  nome?: string;
  cargo?: string;
  telefone?: string;
  site?: string;
  extra?: string;
  incluirLogo?: boolean;
}

export interface Assinatura {
  html: string;
  texto: string;
}

export function escaparHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/** Só http(s) absoluto; qualquer outra coisa é descartada. */
export function siteSeguro(s: string | undefined): string | null {
  const v = s?.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** CID do logo nas assinaturas (o envio anexa o logo inline com este id). */
export const CID_LOGO = "logo@correio";

const CID_VALIDO = /^[A-Za-z0-9._@-]{1,100}$/;

const FONTE =
  "font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;color:#333333;";

/**
 * Gera a assinatura em HTML (tabela) e texto puro. O logo só entra com
 * `incluirLogo` e um `logoCid` (anexo inline montado no envio).
 */
export function gerarAssinatura(
  campos: CamposAssinatura,
  opc: { logoCid?: string } = {},
): Assinatura {
  const t = (s: string | undefined) => s?.trim() || null;
  const nome = t(campos.nome);
  const cargo = t(campos.cargo);
  const telefone = t(campos.telefone);
  const site = siteSeguro(campos.site);
  const extra = t(campos.extra);

  const linhasTexto = [nome, cargo, telefone, site, extra].filter(
    (x): x is string => x !== null,
  );
  if (linhasTexto.length === 0) return { html: "", texto: "" };

  const linhas: string[] = [];
  if (nome) {
    linhas.push(
      `<div style="font-weight:bold;font-size:14px;color:#111111;">${
        escaparHtml(nome)
      }</div>`,
    );
  }
  if (cargo) linhas.push(`<div>${escaparHtml(cargo)}</div>`);
  if (telefone) linhas.push(`<div>${escaparHtml(telefone)}</div>`);
  if (site) {
    const exibido = site.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    linhas.push(
      `<div><a href="${
        escaparHtml(site)
      }" style="color:#0a66c2;text-decoration:none;">${
        escaparHtml(exibido)
      }</a></div>`,
    );
  }
  if (extra) {
    linhas.push(`<div style="color:#666666;">${escaparHtml(extra)}</div>`);
  }

  const cid = opc.logoCid;
  const logo = campos.incluirLogo && cid && CID_VALIDO.test(cid)
    ? `<td style="padding-right:12px;vertical-align:top;"><img src="cid:${cid}" alt="" width="64" style="display:block;border:0;width:64px;max-width:64px;height:auto;"></td>`
    : "";

  const html =
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="${FONTE}"><tr>${logo}<td style="vertical-align:top;">${
      linhas.join("")
    }</td></tr></table>`;
  return { html, texto: linhasTexto.join("\n") };
}
