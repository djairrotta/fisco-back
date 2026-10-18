/**
 * Envio: Resend para e-mail, open-wa para WhatsApp, poste.io recebe.
 * Regra global da casa: tudo ENVIA pelo Resend; recebimento via Cloudflare
 * roteado para o poste.io. Evolution API nao entra em nenhum projeto.
 *
 * Publico do produto: contadores e gestores de empresas. O envio em massa
 * para empresas (campanhas) existe e mora em routes/campanhas.ts, com as
 * travas que o tornam defensavel (LGPD, legitimo interesse em contato B2B):
 * descadastro em todo envio e respeitado para sempre, identificacao do
 * remetente, limite diario, intervalo entre envios, janela de horario e
 * dias uteis, e por padrao sem o contato do contador da empresa.
 */
import { request } from "undici";
import { env } from "../lib/env.js";

export async function enviarEmail(o: {
  para: string; assunto: string; html: string; texto?: string; anexos?: { filename: string; content: string }[];
  remetenteNome?: string | null; responderPara?: string | null; cabecalhos?: Record<string, string>;
}) {
  const r = await request("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: o.remetenteNome ? `${o.remetenteNome.replace(/[<>"]/g, "")} <${env.EMAIL_REMETENTE}>` : env.EMAIL_REMETENTE,
      to: o.para, subject: o.assunto, html: o.html, text: o.texto, attachments: o.anexos,
      reply_to: o.responderPara || undefined, headers: o.cabecalhos,
    }),
  });
  if (r.statusCode >= 300) throw new Error(`Resend ${r.statusCode}: ${(await r.body.text()).slice(0, 200)}`);
  return r.body.json() as Promise<{ id?: string }>;
}

/** Caixas do poste.io: leitura e aliases do dominio proprio. */
export async function listarCaixas() {
  const r = await request(`${env.POSTEIO_BASE_URL}/admin/api/v1/boxes`, {
    headers: { Authorization: `Basic ${Buffer.from(env.POSTEIO_AUTH ?? "").toString("base64")}` },
  });
  return r.statusCode === 200 ? r.body.json() : [];
}

export async function enviarWhatsapp(o: { para: string; texto: string }) {
  // open-wa. Evolution API e proibida em todos os projetos da casa.
  const r = await request(`${env.OPENWA_BASE_URL}/sendText`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": env.OPENWA_API_KEY ?? "" },
    body: JSON.stringify({
      args: { to: `${o.para.replace(/\D/g, "")}@c.us`, content: o.texto },
    }),
  });
  if (r.statusCode >= 300) throw new Error(`open-wa ${r.statusCode}`);
  return r.body.json();
}

/** Alerta de publicacao nova, pelos canais que o assinante escolheu. */
export async function alertarPublicacao(o: {
  canais: string[]; email?: string; whatsapp?: string;
  classe: string; numeroCnj: string | null; prazoDias: number | null; urgente: boolean;
}) {
  const titulo = o.urgente ? `URGENTE: ${o.classe}` : `Nova publicação: ${o.classe}`;
  const corpo = [
    o.numeroCnj ? `Processo ${o.numeroCnj}` : "Processo não identificado na publicação",
    o.prazoDias ? `Prazo de ${o.prazoDias} dias` : null,
  ].filter(Boolean).join(". ");

  const envios: Promise<unknown>[] = [];
  if (o.canais.includes("email") && o.email)
    envios.push(enviarEmail({ para: o.email, assunto: titulo, html: `<p>${corpo}</p>` }));
  if (o.canais.includes("whatsapp") && o.whatsapp)
    envios.push(enviarWhatsapp({ para: o.whatsapp, texto: `${titulo}\n${corpo}` }));
  await Promise.allSettled(envios);
}
