/**
 * Campanhas: envio em massa de e-mail (Resend) e WhatsApp (open-wa) para as
 * empresas de uma pesquisa, de uma lista importada ou de CNPJs escolhidos.
 *
 * Travas (nao sao opcionais):
 *  - descadastro: link em todo e-mail (e List-Unsubscribe), "responda SAIR"
 *    no WhatsApp; quem saiu nunca mais recebe do mesmo escritorio;
 *  - uma mensagem por destino por campanha; limite diario por campanha;
 *    intervalo entre envios; so na janela de horario (Brasilia) e, por
 *    padrao, em dias uteis;
 *  - por padrao pula e-mail/telefone do contador (repetido em 5+ empresas);
 *  - WhatsApp com teto menor (o numero e bloqueado se mandar demais).
 */
import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { pool, q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { lista, numero, sessao } from "../lib/http.js";
import { enviarEmail, enviarWhatsapp } from "../services/mensageria.js";
import { montarBusca } from "./busca.js";

const MAX_DESTINOS = 100_000;
const TETO_WHATS_DIA = 300;
const VARS = ["empresa", "fantasia", "razao_social", "cidade", "uf", "atividade", "cnpj", "socio"] as const;

const normEmail = (e: string) => e.trim().toLowerCase();
const normFone = (t: string) => t.replace(/\D/g, "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function token(tenant: string, destino: string, canal: string) {
  const corpo = Buffer.from(JSON.stringify([tenant, destino, canal])).toString("base64url");
  const sig = createHmac("sha256", env.JWT_SECRET).update("descad:" + corpo).digest("base64url").slice(0, 22);
  return `${corpo}.${sig}`;
}
function lerToken(t: string): [string, string, string] | null {
  const [corpo, sig] = String(t || "").split(".");
  if (!corpo || !sig) return null;
  const ok = createHmac("sha256", env.JWT_SECRET).update("descad:" + corpo).digest("base64url").slice(0, 22);
  if (ok.length !== sig.length || !timingSafeEqual(Buffer.from(ok), Buffer.from(sig))) return null;
  try { return JSON.parse(Buffer.from(corpo, "base64url").toString()); } catch { return null; }
}

/** {{empresa}} etc. Variavel sem valor vira vazio (nunca "{{x}}" no envio). */
export function preencher(modelo: string, d: Record<string, string | null | undefined>) {
  return modelo.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => String(d[k] ?? "")).replace(/[ \t]+\n/g, "\n");
}

function htmlEmail(corpo: string, rodape: string) {
  const ps = corpo.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font:15px/1.55 -apple-system,Segoe UI,Arial,sans-serif;color:#1d2433;max-width:580px">${ps}
<hr style="border:0;border-top:1px solid #e3e6ea;margin:22px 0 12px"><p style="font-size:12px;color:#6b7280;margin:0">${rodape}</p></div>`;
}

/** Hora/dia em Brasilia. */
function agoraBrasilia() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false, weekday: "short" }).formatToParts(new Date());
  return { hora: Number(p.find((x) => x.type === "hour")?.value ?? 0) % 24, dia: p.find((x) => x.type === "weekday")?.value ?? "" };
}

async function dadosEmpresas(where: string, params: unknown[], limite: number) {
  return q<any>(
    `SELECT e.cnpj, e.razao_social, e.nome_fantasia, e.municipio, e.uf, e.email, e.telefone, e.telefone2,
            coalesce(e.email_contador, false) AS email_contador, coalesce(e.telefone_contador, false) AS telefone_contador,
            (SELECT descricao FROM cnae_ref c WHERE c.codigo = e.cnae_principal) AS atividade,
            (SELECT nome FROM socio s WHERE s.cnpj_raiz = e.cnpj_raiz AND s.tipo = 'PF' ORDER BY entrada NULLS LAST LIMIT 1) AS socio
       FROM estabelecimento e ${where} ORDER BY e.pontos_contato DESC NULLS LAST, e.cnpj LIMIT ${limite}`, params);
}

const titulo = (s?: string | null) => (s || "").toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export function camposDaEmpresa(e: any) {
  const fantasia = e.nome_fantasia && !/^\*+$/.test(e.nome_fantasia) ? titulo(e.nome_fantasia) : "";
  return {
    empresa: fantasia || titulo(e.razao_social) || "sua empresa", fantasia, razao_social: e.razao_social ?? "",
    cidade: titulo(e.municipio), uf: e.uf ?? "", atividade: (e.atividade ?? "").toLowerCase(), cnpj: e.cnpj,
    socio: e.socio ? titulo(String(e.socio).split(" ")[0]) : "",
  };
}

/** Passo do envio: uma mensagem de uma campanha por vez. */
async function passoEnvio() {
  const { hora, dia } = agoraBrasilia();
  const campanhas = await q<any>(
    `SELECT c.*, (SELECT count(*) FROM campanha_envio v WHERE v.campanha_id = c.id AND v.status = 'enviado'
                    AND v.enviado_em > date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS hoje
       FROM campanha c WHERE c.status = 'enviando'
        AND (c.ultimo_envio IS NULL OR c.ultimo_envio < now() - make_interval(secs => c.intervalo_s))`);
  for (const c of campanhas) {
    if (hora < c.janela_ini || hora >= c.janela_fim) continue;
    if (c.so_dias_uteis && (dia === "Sat" || dia === "Sun")) continue;
    if (Number(c.hoje) >= c.limite_dia) continue;
    if (c.canal === "email" && !env.RESEND_API_KEY) continue;
    if (c.canal === "whatsapp" && !env.OPENWA_BASE_URL) continue;

    const cli = await pool.connect();
    let item: any;
    try {
      await cli.query("BEGIN");
      const r = await cli.query(`SELECT * FROM campanha_envio WHERE campanha_id = $1 AND status = 'pendente' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`, [c.id]);
      item = r.rows[0];
      if (!item) {
        await cli.query(`UPDATE campanha SET status = 'concluida', concluida_em = now() WHERE id = $1`, [c.id]);
        await cli.query("COMMIT"); continue;
      }
      await cli.query(`UPDATE campanha SET ultimo_envio = now() WHERE id = $1`, [c.id]);
      const [desc] = (await cli.query(`SELECT 1 FROM descadastro WHERE tenant_id = $1 AND destino = $2`, [c.tenant_id, item.destino])).rows;
      if (desc) { await cli.query(`UPDATE campanha_envio SET status = 'descadastrado' WHERE id = $1`, [item.id]); await cli.query("COMMIT"); continue; }
      await cli.query(`UPDATE campanha_envio SET status = 'enviando' WHERE id = $1`, [item.id]);
      await cli.query("COMMIT");
    } catch (e) { await cli.query("ROLLBACK").catch(() => {}); throw e; } finally { cli.release(); }

    const d = item.dados ?? {};
    try {
      let idExt: string | undefined;
      if (c.canal === "email") {
        const link = `${env.API_PUBLICA_URL}/api/publico/descadastro?t=${token(c.tenant_id, item.destino, "email")}`;
        const corpo = preencher(c.corpo, d);
        const rodape = `${esc(c.remetente_nome || "")} enviou esta mensagem para ${esc(d.empresa || "")} com base no cadastro público da empresa na Receita Federal. ` +
          `<a href="${link}" style="color:#6b7280">Não quero receber mais mensagens</a>.`;
        const r = await enviarEmail({
          para: item.destino, assunto: preencher(c.assunto || "", d), html: htmlEmail(corpo, rodape),
          texto: `${corpo}\n\n--\nPara não receber mais: ${link}`, remetenteNome: c.remetente_nome, responderPara: c.responder_para,
          cabecalhos: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        });
        idExt = r?.id;
      } else {
        const texto = `${preencher(c.corpo, d)}\n\n_Para não receber mais, responda SAIR._`;
        const r: any = await enviarWhatsapp({ para: `55${item.destino}`, texto });
        idExt = r?.response ?? r?.id;
      }
      await q(`UPDATE campanha_envio SET status = 'enviado', enviado_em = now(), id_externo = $2 WHERE id = $1`, [item.id, idExt ? String(idExt).slice(0, 120) : null]);
    } catch (e) {
      await q(`UPDATE campanha_envio SET status = 'erro', erro = $2, enviado_em = now() WHERE id = $1`, [item.id, String(e instanceof Error ? e.message : e).slice(0, 300)]);
      // Muitos erros seguidos: pausa (chave errada, numero desconectado).
      const [{ erros }] = await q<{ erros: string }>(
        `SELECT count(*) AS erros FROM (SELECT status FROM campanha_envio WHERE campanha_id = $1 AND enviado_em IS NOT NULL ORDER BY enviado_em DESC LIMIT 10) x WHERE status = 'erro'`, [c.id]);
      if (Number(erros) >= 10) await q(`UPDATE campanha SET status = 'pausada' WHERE id = $1`, [c.id]);
    }
  }
}

export function iniciarEnvioCampanhas() {
  let ocupado = false;
  setInterval(async () => {
    if (ocupado) return;
    ocupado = true;
    try { await passoEnvio(); } catch (e) { console.error("[campanhas]", e instanceof Error ? e.message : e); } finally { ocupado = false; }
  }, 5_000).unref();
}

export default async function rotasCampanhas(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  // ---------------- modelos ----------------
  app.get("/api/modelos", auth, async (req) => q(`SELECT * FROM modelo_mensagem WHERE tenant_id = $1 ORDER BY atualizado_em DESC`, [sessao(req).tenant]));
  app.post<{ Body: any }>("/api/modelos", auth, async (req, reply) => {
    const b: any = req.body ?? {};
    if (!b.nome || !b.corpo || !["email", "whatsapp"].includes(b.canal)) return reply.code(400).send({ erro: "Nome, canal e texto são obrigatórios." });
    const [m] = await q(`INSERT INTO modelo_mensagem (tenant_id, nome, canal, assunto, corpo) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [sessao(req).tenant, String(b.nome).slice(0, 120), b.canal, b.assunto ? String(b.assunto).slice(0, 200) : null, String(b.corpo).slice(0, 8000)]);
    return m;
  });
  app.put<{ Params: { id: string }; Body: any }>("/api/modelos/:id", auth, async (req) => {
    const b: any = req.body ?? {};
    const [m] = await q(`UPDATE modelo_mensagem SET nome = coalesce($3, nome), assunto = $4, corpo = coalesce($5, corpo), atualizado_em = now()
                          WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [req.params.id, sessao(req).tenant, b.nome ?? null, b.assunto ?? null, b.corpo ?? null]);
    return m ?? null;
  });
  app.delete<{ Params: { id: string } }>("/api/modelos/:id", auth, async (req) => {
    await q(`DELETE FROM modelo_mensagem WHERE id = $1 AND tenant_id = $2`, [req.params.id, sessao(req).tenant]);
    return { ok: true };
  });

  // ---------------- campanhas ----------------
  app.get("/api/campanhas/estado", auth, async () => ({
    email: !!env.RESEND_API_KEY, whatsapp: !!env.OPENWA_BASE_URL, remetente: env.EMAIL_REMETENTE, teto_whatsapp_dia: TETO_WHATS_DIA, variaveis: VARS,
  }));

  app.get("/api/campanhas", auth, async (req) => q(
    `SELECT c.id, c.nome, c.canal, c.status, c.criado_em, c.iniciada_em, c.concluida_em, c.limite_dia,
            count(v.*) AS total, count(v.*) FILTER (WHERE v.status = 'enviado') AS enviados,
            count(v.*) FILTER (WHERE v.status = 'erro') AS erros, count(v.*) FILTER (WHERE v.status = 'pendente') AS pendentes,
            count(v.*) FILTER (WHERE v.status = 'descadastrado') AS descadastrados
       FROM campanha c LEFT JOIN campanha_envio v ON v.campanha_id = c.id
      WHERE c.tenant_id = $1 GROUP BY c.id ORDER BY c.criado_em DESC LIMIT 100`, [sessao(req).tenant]));

  app.post<{ Body: any }>("/api/campanhas", auth, async (req, reply) => {
    const { tenant, sub } = sessao(req);
    const b: any = req.body ?? {};
    if (!["email", "whatsapp"].includes(b.canal)) return reply.code(400).send({ erro: "Canal inválido." });
    if (!String(b.corpo || "").trim()) return reply.code(400).send({ erro: "Escreva a mensagem." });
    if (b.canal === "email" && !String(b.assunto || "").trim()) return reply.code(400).send({ erro: "E-mail precisa de assunto." });
    const origem = b.origem?.lista_id ? { lista_id: String(b.origem.lista_id) } : b.origem?.cnpjs?.length ? { cnpjs: lista(b.origem.cnpjs).slice(0, 5000) } : { filtros: b.origem?.filtros ?? {} };
    const teto = b.canal === "whatsapp" ? TETO_WHATS_DIA : 5000;
    const [c] = await q(
      `INSERT INTO campanha (tenant_id, nome, canal, assunto, corpo, origem, limite_dia, intervalo_s, janela_ini, janela_fim, so_dias_uteis,
                             ocultar_contador, remetente_nome, responder_para, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [tenant, String(b.nome || "Campanha").slice(0, 120), b.canal, b.assunto ? String(b.assunto).slice(0, 200) : null, String(b.corpo).slice(0, 8000),
       JSON.stringify(origem), numero(b.limite_dia, b.canal === "whatsapp" ? 80 : 300, 1, teto),
       numero(b.intervalo_s, b.canal === "whatsapp" ? 45 : 10, b.canal === "whatsapp" ? 20 : 2, 600),
       numero(b.janela_ini, 8, 0, 23), numero(b.janela_fim, 19, 1, 24), b.so_dias_uteis !== false, b.ocultar_contador !== false,
       b.remetente_nome ? String(b.remetente_nome).slice(0, 80) : null, b.responder_para ? String(b.responder_para).slice(0, 120) : null, sub]);
    return c;
  });

  app.get<{ Params: { id: string } }>("/api/campanhas/:id", auth, async (req, reply) => {
    const [c] = await q(`SELECT * FROM campanha WHERE id = $1 AND tenant_id = $2`, [req.params.id, sessao(req).tenant]);
    if (!c) return reply.code(404).send({ erro: "Campanha não encontrada." });
    const [cont] = await q(`SELECT count(*) AS total, count(*) FILTER (WHERE status = 'enviado') AS enviados, count(*) FILTER (WHERE status = 'erro') AS erros,
                                   count(*) FILTER (WHERE status = 'pendente') AS pendentes, count(*) FILTER (WHERE status = 'descadastrado') AS descadastrados,
                                   count(*) FILTER (WHERE status = 'enviado' AND enviado_em > date_trunc('day', now())) AS hoje
                              FROM campanha_envio WHERE campanha_id = $1`, [c.id]);
    const por_dia = await q(`SELECT to_char(enviado_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia, count(*) FILTER (WHERE status = 'enviado') AS enviados,
                                    count(*) FILTER (WHERE status = 'erro') AS erros
                               FROM campanha_envio WHERE campanha_id = $1 AND enviado_em IS NOT NULL GROUP BY 1 ORDER BY 1`, [c.id]);
    const [amostra] = await q(`SELECT dados, destino FROM campanha_envio WHERE campanha_id = $1 ORDER BY id LIMIT 1`, [c.id]);
    const previa = amostra ? { destino: amostra.destino, assunto: preencher(c.assunto || "", amostra.dados), corpo: preencher(c.corpo, amostra.dados) } : null;
    return { campanha: c, contagem: cont, por_dia, previa };
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; pagina?: string } }>("/api/campanhas/:id/envios", auth, async (req) => {
    const pagina = numero(req.query.pagina, 1, 1, 10000);
    return q(`SELECT v.cnpj, v.destino, v.status, v.erro, v.enviado_em, v.dados->>'empresa' AS empresa
                FROM campanha_envio v JOIN campanha c ON c.id = v.campanha_id
               WHERE v.campanha_id = $1 AND c.tenant_id = $2 ${req.query.status ? "AND v.status = $3" : ""}
               ORDER BY v.id LIMIT 50 OFFSET ${(pagina - 1) * 50}`,
      req.query.status ? [req.params.id, sessao(req).tenant, req.query.status] : [req.params.id, sessao(req).tenant]);
  });

  /** Monta a lista de destinos (uma vez): empresas da origem, contato escolhido, sem descadastrados. */
  app.post<{ Params: { id: string } }>("/api/campanhas/:id/preparar", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [c] = await q<any>(`SELECT * FROM campanha WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant]);
    if (!c) return reply.code(404).send({ erro: "Campanha não encontrada." });
    if (!["rascunho", "preparada"].includes(c.status)) return reply.code(409).send({ erro: "A campanha já começou." });
    const o = c.origem ?? {};
    const f = o.lista_id ? { lista: o.lista_id, situacao: "2" } : o.cnpjs ? { cnpjs: o.cnpjs.join(","), situacao: "todas" } : { ...(o.filtros ?? {}) };
    f.contato = c.canal === "email" ? "email" : "celular";
    if (c.ocultar_contador) f.ocultar_contador = "1";
    const { where, params } = await montarBusca(f, tenant);
    const empresas = await dadosEmpresas(where, params, MAX_DESTINOS);
    const sair = new Set((await q<{ destino: string }>(`SELECT destino FROM descadastro WHERE tenant_id = $1`, [tenant])).map((x) => x.destino));
    const vistos = new Set<string>();
    const linhas: [string, string, string][] = [];
    for (const e of empresas) {
      let destino: string | null = null;
      if (c.canal === "email") {
        if (e.email && !(c.ocultar_contador && e.email_contador)) destino = normEmail(e.email);
      } else {
        const cel = [e.telefone, e.telefone2].map((t: string) => normFone(t || "")).find((t: string) => /^\d{2}9\d{8}$/.test(t));
        if (cel && !(c.ocultar_contador && e.telefone_contador && cel === normFone(e.telefone || ""))) destino = cel;
      }
      if (!destino || vistos.has(destino) || sair.has(destino)) continue;
      vistos.add(destino);
      linhas.push([e.cnpj, destino, JSON.stringify(camposDaEmpresa(e))]);
    }
    const cli = await pool.connect();
    try {
      await cli.query("BEGIN");
      await cli.query(`DELETE FROM campanha_envio WHERE campanha_id = $1`, [c.id]);
      for (let i = 0; i < linhas.length; i += 2000) {
        const fatia = linhas.slice(i, i + 2000);
        await cli.query(
          `INSERT INTO campanha_envio (campanha_id, tenant_id, cnpj, destino, dados)
           SELECT $1, $2, x.cnpj, x.destino, x.dados::jsonb FROM unnest($3::text[], $4::text[], $5::text[]) AS x(cnpj, destino, dados)
           ON CONFLICT DO NOTHING`, [c.id, tenant, fatia.map((l) => l[0]), fatia.map((l) => l[1]), fatia.map((l) => l[2])]);
      }
      await cli.query(`UPDATE campanha SET status = 'preparada' WHERE id = $1`, [c.id]);
      await cli.query("COMMIT");
    } catch (e) { await cli.query("ROLLBACK").catch(() => {}); throw e; } finally { cli.release(); }
    return { empresas: empresas.length, destinos: linhas.length, descadastrados: [...sair].length };
  });

  app.post<{ Params: { id: string }; Body: { destino?: string } }>("/api/campanhas/:id/teste", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [c] = await q<any>(`SELECT * FROM campanha WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant]);
    if (!c) return reply.code(404).send({ erro: "Campanha não encontrada." });
    const destino = String(req.body?.destino || "").trim();
    const [a] = await q(`SELECT dados FROM campanha_envio WHERE campanha_id = $1 ORDER BY id LIMIT 1`, [c.id]);
    const d = a?.dados ?? { empresa: "Empresa Exemplo", cidade: "Campinas", uf: "SP", atividade: "comércio varejista", socio: "Maria" };
    try {
      if (c.canal === "email") {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) return reply.code(400).send({ erro: "E-mail de teste inválido." });
        await enviarEmail({ para: destino, assunto: `[teste] ${preencher(c.assunto || "", d)}`, html: htmlEmail(preencher(c.corpo, d), "Mensagem de teste da campanha."), remetenteNome: c.remetente_nome, responderPara: c.responder_para });
      } else {
        const t = normFone(destino);
        if (!/^\d{10,11}$/.test(t)) return reply.code(400).send({ erro: "Celular de teste inválido (DDD + número)." });
        await enviarWhatsapp({ para: `55${t}`, texto: `[teste] ${preencher(c.corpo, d)}` });
      }
      return { ok: true };
    } catch (e) { return reply.code(502).send({ erro: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  });

  for (const [acao, de, para] of [["iniciar", ["preparada", "pausada"], "enviando"], ["pausar", ["enviando"], "pausada"], ["cancelar", ["rascunho", "preparada", "pausada", "enviando"], "cancelada"]] as const) {
    app.post<{ Params: { id: string } }>(`/api/campanhas/:id/${acao}`, auth, async (req, reply) => {
      const { tenant } = sessao(req);
      const [c] = await q<any>(`SELECT status, canal FROM campanha WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant]);
      if (!c) return reply.code(404).send({ erro: "Campanha não encontrada." });
      if (!(de as readonly string[]).includes(c.status)) return reply.code(409).send({ erro: `Não dá para ${acao} uma campanha ${c.status}.` });
      if (acao === "iniciar" && c.canal === "email" && !env.RESEND_API_KEY) return reply.code(412).send({ erro: "Envio de e-mail não configurado (RESEND_API_KEY)." });
      if (acao === "iniciar" && c.canal === "whatsapp" && !env.OPENWA_BASE_URL) return reply.code(412).send({ erro: "WhatsApp não configurado (open-wa)." });
      await q(`UPDATE campanha SET status = $2, iniciada_em = CASE WHEN $2 = 'enviando' THEN coalesce(iniciada_em, now()) ELSE iniciada_em END WHERE id = $1`, [req.params.id, para]);
      if (acao === "cancelar") await q(`UPDATE campanha_envio SET status = 'cancelado' WHERE campanha_id = $1 AND status = 'pendente'`, [req.params.id]);
      return { ok: true, status: para };
    });
  }

  // ---------------- descadastro ----------------
  app.get("/api/descadastros", auth, async (req) => q(`SELECT destino, canal, origem, criado_em FROM descadastro WHERE tenant_id = $1 ORDER BY criado_em DESC LIMIT 500`, [sessao(req).tenant]));
  app.post<{ Body: { destino?: string } }>("/api/descadastros", auth, async (req, reply) => {
    const d = String(req.body?.destino || "").trim();
    const destino = d.includes("@") ? normEmail(d) : normFone(d).replace(/^55(?=\d{10,11}$)/, "");
    if (!destino) return reply.code(400).send({ erro: "Informe e-mail ou telefone." });
    await q(`INSERT INTO descadastro (tenant_id, destino, canal, origem) VALUES ($1, $2, $3, 'manual') ON CONFLICT DO NOTHING`,
      [sessao(req).tenant, destino, d.includes("@") ? "email" : "whatsapp"]);
    await q(`UPDATE campanha_envio SET status = 'descadastrado' WHERE tenant_id = $1 AND destino = $2 AND status = 'pendente'`, [sessao(req).tenant, destino]);
    return { ok: true };
  });

  /** Link publico do e-mail (sem login). GET mostra a confirmacao; POST e o one-click. */
  const sair = async (t: string) => {
    const x = lerToken(t);
    if (!x) return false;
    const [tenant, destino, canal] = x;
    await q(`INSERT INTO descadastro (tenant_id, destino, canal, origem) VALUES ($1, $2, $3, 'link') ON CONFLICT DO NOTHING`, [tenant, destino, canal]);
    await q(`UPDATE campanha_envio SET status = 'descadastrado' WHERE tenant_id = $1 AND destino = $2 AND status = 'pendente'`, [tenant, destino]);
    return true;
  };
  app.get<{ Querystring: { t?: string } }>("/api/publico/descadastro", async (req, reply) => {
    const ok = await sair(req.query.t || "");
    reply.header("content-type", "text/html; charset=utf-8");
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Descadastro</title>
<body style="font:16px/1.5 -apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#1d2433">
<h1 style="font-size:20px">${ok ? "Pronto, você não vai mais receber mensagens deste remetente." : "Link inválido ou expirado."}</h1>
<p style="color:#6b7280">${ok ? "O pedido foi registrado e vale para todas as campanhas futuras." : "Responda o e-mail pedindo para sair que o remetente faz o descadastro."}</p></body>`;
  });
  app.post<{ Querystring: { t?: string } }>("/api/publico/descadastro", async (req) => ({ ok: await sair(req.query.t || "") }));
}
