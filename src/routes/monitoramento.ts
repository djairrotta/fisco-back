/**
 * Monitoramento da carteira: empresas das listas marcadas "monitorar"
 * (clientes do escritorio) sao comparadas todo dia com a foto anterior.
 * Mudou situacao cadastral, saiu do Simples/MEI, entrou divida nova,
 * acordo caiu, foi ajuizada: vira alerta na tela e no e-mail das 7h.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { sessao } from "../lib/http.js";
import { enviarEmail } from "../services/mensageria.js";

const SIT: Record<number, string> = { 1: "nula", 2: "ativa", 3: "suspensa", 4: "inapta", 8: "baixada" };
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export async function compararCarteiras() {
  const atuais = await q<any>(
    `WITH alvo AS (SELECT DISTINCT l.tenant_id, unnest(l.cnpjs) AS cnpj FROM lista_importada l WHERE l.monitorar)
     SELECT a.tenant_id, a.cnpj, coalesce(e.nome_fantasia, e.razao_social, d.nome) AS nome, e.situacao, e.opcao_simples, e.opcao_mei,
            coalesce(d.valor_total, 0) AS divida_total, coalesce(d.qtd_inscricoes, 0) AS inscricoes,
            coalesce(d.qtd_rescindidas, 0) AS rescindidas, coalesce(d.tem_ajuizada, false) AS ajuizada,
            f.cnpj IS NOT NULL AS tem_foto, f.situacao AS f_situacao, f.opcao_simples AS f_simples, f.opcao_mei AS f_mei,
            f.divida_total AS f_divida, f.inscricoes AS f_inscricoes, f.rescindidas AS f_rescindidas, f.ajuizada AS f_ajuizada
       FROM alvo a
       LEFT JOIN estabelecimento e ON e.cnpj = a.cnpj
       LEFT JOIN mv_devedor d ON d.cnpj_raiz = left(a.cnpj, 8)
       LEFT JOIN monitor_foto f ON f.tenant_id = a.tenant_id AND f.cnpj = a.cnpj`);
  let alertas = 0;
  for (const x of atuais) {
    const nome = x.nome || x.cnpj;
    const novos: [string, string][] = [];
    if (x.tem_foto) {
      if (x.situacao != null && x.f_situacao != null && x.situacao !== x.f_situacao)
        novos.push(["situacao", `${nome}: situação cadastral mudou de ${SIT[x.f_situacao] ?? x.f_situacao} para ${SIT[x.situacao] ?? x.situacao}.`]);
      if (x.f_simples === true && x.opcao_simples === false) novos.push(["simples", `${nome} foi excluída do Simples Nacional.`]);
      if (x.f_mei === true && x.opcao_mei === false) novos.push(["mei", `${nome} saiu do MEI.`]);
      const dv = Number(x.divida_total), fdv = Number(x.f_divida ?? 0);
      if (Number(x.inscricoes) > Number(x.f_inscricoes ?? 0)) novos.push(["divida_nova", `${nome}: ${Number(x.inscricoes) - Number(x.f_inscricoes ?? 0)} inscrição(ões) nova(s) em dívida ativa federal (total ${brl(dv)}).`]);
      else if (fdv > 0 && dv > fdv * 1.1) novos.push(["divida_subiu", `${nome}: dívida ativa federal subiu de ${brl(fdv)} para ${brl(dv)}.`]);
      if (fdv > 0 && dv === 0) novos.push(["divida_quitada", `${nome} saiu da dívida ativa federal.`]);
      if (Number(x.rescindidas) > Number(x.f_rescindidas ?? 0)) novos.push(["acordo_caiu", `${nome}: acordo/parcelamento com a PGFN rescindido.`]);
      if (x.ajuizada && !x.f_ajuizada) novos.push(["ajuizada", `${nome}: dívida federal foi ajuizada (execução fiscal).`]);
    }
    for (const [tipo, texto] of novos) {
      await q(`INSERT INTO monitor_alerta (tenant_id, cnpj, tipo, texto) VALUES ($1, $2, $3, $4)`, [x.tenant_id, x.cnpj, tipo, texto]);
      alertas++;
    }
    await q(`INSERT INTO monitor_foto (tenant_id, cnpj, situacao, opcao_simples, opcao_mei, divida_total, inscricoes, rescindidas, ajuizada)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (tenant_id, cnpj) DO UPDATE SET situacao = EXCLUDED.situacao, opcao_simples = EXCLUDED.opcao_simples,
               opcao_mei = EXCLUDED.opcao_mei, divida_total = EXCLUDED.divida_total, inscricoes = EXCLUDED.inscricoes,
               rescindidas = EXCLUDED.rescindidas, ajuizada = EXCLUDED.ajuizada, atualizado_em = now()`,
      [x.tenant_id, x.cnpj, x.situacao, x.opcao_simples, x.opcao_mei, x.divida_total, x.inscricoes, x.rescindidas, x.ajuizada]);
  }
  return { empresas: atuais.length, alertas };
}

async function avisarPorEmail() {
  if (!env.RESEND_API_KEY) return;
  const grupos = await q<any>(
    `SELECT a.tenant_id, json_agg(json_build_object('cnpj', a.cnpj, 'texto', a.texto) ORDER BY a.id) AS itens, array_agg(a.id) AS ids
       FROM monitor_alerta a WHERE NOT a.avisado GROUP BY a.tenant_id`);
  for (const g of grupos) {
    const us = await q<{ email: string }>(`SELECT email FROM usuario WHERE tenant_id = $1 AND lembrete_email`, [g.tenant_id]);
    const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#1d2433;max-width:560px">
      <p>Mudanças nas empresas que você monitora:</p><ul style="padding-left:18px">${g.itens.map((i: any) =>
        `<li style="margin:0 0 8px"><a href="https://fisco.judinfo.com.br/app/empresas/${i.cnpj}" style="color:#0A938A">${esc(i.texto)}</a></li>`).join("")}</ul></div>`;
    for (const u of us) await enviarEmail({ para: u.email, assunto: `${g.itens.length} mudança(s) na sua carteira`, html }).catch(() => {});
    await q(`UPDATE monitor_alerta SET avisado = true WHERE id = ANY($1)`, [g.ids]);
  }
}

export function iniciarMonitoramento() {
  let ultimo = "";
  setInterval(async () => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date());
    const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    const dia = `${v("year")}-${v("month")}-${v("day")}`;
    if (Number(v("hour")) % 24 < 6 || ultimo === dia) return;
    ultimo = dia;
    try { const r = await compararCarteiras(); console.log(`[monitor] ${r.empresas} empresas, ${r.alertas} alertas`); await avisarPorEmail(); }
    catch (e) { console.error("[monitor]", e instanceof Error ? e.message : e); }
  }, 20 * 60_000).unref();
}

export default async function rotasMonitoramento(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };
  app.put<{ Params: { id: string }; Body: { monitorar?: boolean } }>("/api/listas/:id/monitorar", auth, async (req) => {
    const { tenant } = sessao(req);
    await q(`UPDATE lista_importada SET monitorar = $3 WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant, req.body?.monitorar !== false]);
    // Foto inicial ja, para o primeiro alerta sair na proxima mudanca.
    if (req.body?.monitorar !== false) await compararCarteiras().catch(() => {});
    return { ok: true };
  });
  app.get<{ Querystring: { todos?: string } }>("/api/alertas", auth, async (req) => {
    const { tenant } = sessao(req);
    return q(`SELECT id, cnpj, tipo, texto, lido, criado_em FROM monitor_alerta WHERE tenant_id = $1 ${req.query.todos ? "" : "AND NOT lido"}
               ORDER BY criado_em DESC LIMIT 200`, [tenant]);
  });
  app.post("/api/alertas/lidos", auth, async (req) => {
    await q(`UPDATE monitor_alerta SET lido = true WHERE tenant_id = $1 AND NOT lido`, [sessao(req).tenant]);
    return { ok: true };
  });
}
