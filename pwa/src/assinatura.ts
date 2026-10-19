// Prévia da assinatura no PWA: o MESMO modelo fixo do backend
// (correio/backend/src/caixas/assinatura.ts). O envio real usa o do servidor.
import type { CamposAssinatura } from "./tipos";

export function escaparHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

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

const FONTE = "font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;color:#333333;";

/** HTML da assinatura; `logoUrl` (ex.: /api/marca/:id/logo) entra no lugar do cid na prévia. */
export function gerarAssinatura(campos: CamposAssinatura, opc: { logoUrl?: string | null } = {}): { html: string; texto: string } {
  const t = (s: string | undefined) => s?.trim() || null;
  const nome = t(campos.nome), cargo = t(campos.cargo), telefone = t(campos.telefone);
  const site = siteSeguro(campos.site), extra = t(campos.extra);
  const linhasTexto = [nome, cargo, telefone, site, extra].filter((x): x is string => x !== null);
  if (linhasTexto.length === 0) return { html: "", texto: "" };
  const linhas: string[] = [];
  if (nome) linhas.push(`<div style="font-weight:bold;font-size:14px;color:#111111;">${escaparHtml(nome)}</div>`);
  if (cargo) linhas.push(`<div>${escaparHtml(cargo)}</div>`);
  if (telefone) linhas.push(`<div>${escaparHtml(telefone)}</div>`);
  if (site) {
    const exibido = site.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    linhas.push(`<div><a href="${escaparHtml(site)}" style="color:#0a66c2;text-decoration:none;">${escaparHtml(exibido)}</a></div>`);
  }
  if (extra) linhas.push(`<div style="color:#666666;">${escaparHtml(extra)}</div>`);
  const logo = campos.incluirLogo && opc.logoUrl
    ? `<td style="padding-right:12px;vertical-align:top;"><img src="${escaparHtml(opc.logoUrl)}" alt="" width="64" style="display:block;border:0;width:64px;max-width:64px;height:auto;"></td>`
    : "";
  const html = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="${FONTE}"><tr>${logo}<td style="vertical-align:top;">${linhas.join("")}</td></tr></table>`;
  return { html, texto: linhasTexto.join("\n") };
}
