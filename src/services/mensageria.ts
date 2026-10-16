/**
 * Envio: Resend para e-mail, open-wa para WhatsApp, poste.io recebe.
 * Regra global da casa: tudo ENVIA pelo Resend; recebimento via Cloudflare
 * roteado para o poste.io. Evolution API nao entra em nenhum projeto.
 *
 * ========================================================================
 * LIMITE DELIBERADO: ESTE MODULO FALA COM O ASSINANTE, NAO COM O PROSPECTO.
 * ========================================================================
 * O concorrente generalista vende disparo em massa de e-mail e WhatsApp
 * para prospeccao. Para advogado isso e captacao de clientela: o Codigo de
 * Etica da OAB e o Provimento 205/2021 do CFOAB vedam oferta de servico a
 * destinatario indeterminado e publicidade que nao seja meramente
 * informativa. Um escritorio que usar essa funcao como o concorrente
 * anuncia se expoe a representacao disciplinar.
 *
 * Por isso aqui so existe envio para o PROPRIO assinante: alerta de
 * publicacao, prazo, laudo pronto, cobranca. Nao ha e nao deve haver
 * funcao de disparo em lote para lista de empresas prospectadas.
 * Se alguem pedir, a resposta e esta nota.
 */
import { request } from "undici";
import { env } from "../lib/env.js";

export async function enviarEmail(o: {
  /** SEMPRE o e-mail do proprio assinante. Ver a nota no topo do arquivo. */
  para: string; assunto: string; html: string; anexos?: { filename: string; content: string }[];
}) {
  const r = await request("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_REMETENTE, to: o.para, subject: o.assunto,
      html: o.html, attachments: o.anexos,
    }),
  });
  if (r.statusCode >= 300) throw new Error(`Resend ${r.statusCode}`);
  return r.body.json();
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
