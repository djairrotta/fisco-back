/**
 * CRM, o que faltava: painel do funil (conversao por fase, entrada por
 * semana, origem, atrasados) e lembrete diario por e-mail com os proximos
 * passos do dia e os atrasados (para o proprio usuario, via Resend).
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { sessao } from "../lib/http.js";
import { enviarEmail } from "../services/mensageria.js";

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function lembretesDoDia() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date());
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const hoje = `${v("year")}-${v("month")}-${v("day")}`;
  if (Number(v("hour")) % 24 < 7 || !env.RESEND_API_KEY) return;
  const usuarios = await q<any>(
    `SELECT u.id, u.nome, u.email, u.tenant_id FROM usuario u
      WHERE u.lembrete_email AND NOT EXISTS (SELECT 1 FROM lembrete_envio e WHERE e.usuario_id = u.id AND e.dia = $1)`, [hoje]);
  for (const u of usuarios) {
    const itens = await q<any>(
      `SELECT id, nome, proximo_passo, proximo_em, fase FROM lead_juridico
        WHERE tenant_id = $1 AND removido_em IS NULL AND proximo_em IS NOT NULL AND proximo_em <= $2
          AND (responsavel IS NULL OR responsavel = '' OR responsavel = $3 OR responsavel = $4)
        ORDER BY proximo_em, nome LIMIT 50`, [u.tenant_id, hoje, u.nome, u.email]);
    await q(`INSERT INTO lembrete_envio (usuario_id, dia, itens) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [u.id, hoje, itens.length]);
    if (!itens.length) continue;
    const atras = itens.filter((i) => i.proximo_em < hoje).length;
    const linhas = itens.map((i) => `<li style="margin:0 0 8px"><a href="https://fisco.judinfo.com.br/app/leads?lead=${i.id}" style="color:#0A938A;font-weight:600">${esc(i.nome)}</a>
      <br><span style="color:#6b7280">${i.proximo_em < hoje ? `<b style="color:#b45309">atrasado (${i.proximo_em.split("-").reverse().join("/")})</b> · ` : ""}${esc(i.proximo_passo || "sem descrição")}</span></li>`).join("");
    await enviarEmail({
      para: u.email,
      assunto: `${itens.length} ${itens.length === 1 ? "contato" : "contatos"} para hoje${atras ? ` (${atras} atrasado${atras > 1 ? "s" : ""})` : ""}`,
      html: `<div style="font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#1d2433;max-width:560px">
        <p>Bom dia, ${esc(u.nome.split(" ")[0])}. Os próximos passos do seu funil:</p><ul style="padding-left:18px">${linhas}</ul>
        <p style="font-size:12px;color:#6b7280">Para não receber este resumo, desligue em Leads → Painel do funil.</p></div>`,
    }).catch((e) => console.error("[lembretes]", e instanceof Error ? e.message : e));
  }
}

export function iniciarLembretes() {
  setInterval(() => void lembretesDoDia().catch((e) => console.error("[lembretes]", e)), 15 * 60_000).unref();
}

export default async function rotasCrmExtra(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get("/api/funil/painel", auth, async (req) => {
    const { tenant, sub } = sessao(req);
    const [fases, semanas, origens, [tot], [eu]] = await Promise.all([
      q(`SELECT f.valor, f.rotulo, f.cor, f.posicao, count(l.id) AS leads, coalesce(sum(l.honorario_micros), 0) / 1e6 AS honorarios,
                count(l.id) FILTER (WHERE l.proximo_em < current_date) AS atrasados,
                round(avg(extract(epoch FROM now() - l.atualizado_em) / 86400)) AS dias_parado
           FROM funil_opcao f LEFT JOIN lead_juridico l ON l.tenant_id = f.tenant_id AND l.fase = f.valor AND l.removido_em IS NULL
          WHERE f.tenant_id = $1 AND f.visivel GROUP BY f.valor, f.rotulo, f.cor, f.posicao ORDER BY f.posicao`, [tenant]),
      q(`SELECT to_char(date_trunc('week', criado_em), 'YYYY-MM-DD') AS semana, count(*) AS novos
           FROM lead_juridico WHERE tenant_id = $1 AND removido_em IS NULL AND criado_em > now() - interval '12 weeks'
          GROUP BY 1 ORDER BY 1`, [tenant]),
      q(`SELECT coalesce(extras->>'origem', lower(criado_por_origem::text)) AS origem, count(*) AS n
           FROM lead_juridico WHERE tenant_id = $1 AND removido_em IS NULL GROUP BY 1 ORDER BY 2 DESC`, [tenant]),
      q(`SELECT count(*) AS total, count(*) FILTER (WHERE proximo_em < current_date) AS atrasados,
                count(*) FILTER (WHERE proximo_em = current_date) AS hoje, count(*) FILTER (WHERE proximo_em IS NULL) AS sem_proximo,
                count(*) FILTER (WHERE criado_em > now() - interval '30 days') AS novos_30d
           FROM lead_juridico WHERE tenant_id = $1 AND removido_em IS NULL`, [tenant]),
      q(`SELECT lembrete_email FROM usuario WHERE id = $1`, [sub]),
    ]);
    return { fases, semanas, origens, totais: tot, lembrete_email: eu?.lembrete_email ?? false };
  });

  app.put<{ Body: { ativo?: boolean } }>("/api/eu/lembretes", auth, async (req) => {
    await q(`UPDATE usuario SET lembrete_email = $2 WHERE id = $1`, [sessao(req).sub, req.body?.ativo !== false]);
    return { ok: true };
  });
}
