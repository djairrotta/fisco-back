/**
 * Leads: empresas devedoras que o escritorio decidiu trabalhar.
 *
 * O lead guarda uma FOTO do devedor (nome, UF, divida, tributo) no momento
 * em que entra. A base da PGFN e substituida a cada trimestre; o funil do
 * escritorio nao pode mudar de valor sozinho por causa disso. A ficha
 * mostra a posicao atual ao lado.
 *
 * Contatos: ao criar, o lead puxa telefone e e-mail do cadastro (carga da
 * Receita ou consulta sob demanda). Ficam em `telefones`/`emails` e o
 * escritorio pode editar.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { consultarCadastro } from "../services/cadastro.js";
import { cnpjValido, limparCnpj, naoEncontrado, sessao } from "../lib/http.js";

interface CorpoLead {
  cnpj?: string; nome?: string; fase?: string; posicao?: number;
  telefones?: unknown; emails?: unknown; etiquetas?: string[];
  proximo_passo?: string | null; proximo_em?: string | null;
  honorario?: number | null; probabilidade?: number | null; responsavel?: string | null;
  tese_slug?: string | null;
}

const CAMPOS_LEAD = `id, cnpj, nome, fase, posicao, uf, municipio, divida_total, tributo_principal,
  telefones, emails, etiquetas, proximo_passo, proximo_em, probabilidade, responsavel,
  tese_slug, honorario_micros, criado_em, atualizado_em`;

async function garantirFunil(tenant: string) {
  const [x] = await q<{ n: string }>(`SELECT count(*) AS n FROM funil_opcao WHERE tenant_id = $1`, [tenant]);
  if (Number(x?.n) === 0) await q(`SELECT semear_funil($1)`, [tenant]);
}

export async function registrarEvento(
  tenant: string, alvoId: string, tipo: string, props: Record<string, unknown>, autor?: string,
) {
  await q(
    `INSERT INTO evento_timeline (tenant_id, alvo_tipo, alvo_id, tipo, propriedades, autor_nome)
     VALUES ($1, 'lead', $2, $3, $4, $5)`,
    [tenant, alvoId, tipo, JSON.stringify(props), autor ?? null]).catch(() => {});
}

export default async function rotasLeads(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  // ---------------- funil (colunas do kanban) ----------------
  app.get("/api/funil", auth, async (req) => {
    const { tenant } = sessao(req);
    await garantirFunil(tenant);
    return q(`SELECT id, valor, rotulo, cor, posicao, visivel FROM funil_opcao
               WHERE tenant_id = $1 ORDER BY posicao`, [tenant]);
  });

  app.post<{ Body: { rotulo?: string; cor?: string } }>("/api/funil", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const rotulo = (req.body?.rotulo || "").trim().slice(0, 60);
    if (!rotulo) return reply.code(400).send({ erro: "Informe o nome da fase." });
    const valor = rotulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `FASE_${Date.now()}`;
    const [o] = await q(
      `INSERT INTO funil_opcao (tenant_id, valor, rotulo, cor, posicao)
       VALUES ($1, $2, $3, $4, coalesce((SELECT max(posicao) + 1 FROM funil_opcao WHERE tenant_id = $1), 0))
       ON CONFLICT (tenant_id, valor) DO UPDATE SET visivel = true, rotulo = EXCLUDED.rotulo
       RETURNING id, valor, rotulo, cor, posicao, visivel`,
      [tenant, valor, rotulo, req.body?.cor || "slate"]);
    return reply.code(201).send(o);
  });

  app.patch<{ Params: { id: string }; Body: { rotulo?: string; cor?: string; posicao?: number; visivel?: boolean } }>(
    "/api/funil/:id", auth, async (req, reply) => {
      const { tenant } = sessao(req);
      const b = req.body || {};
      const [o] = await q(
        `UPDATE funil_opcao SET
           rotulo = coalesce($3, rotulo), cor = coalesce($4, cor),
           posicao = coalesce($5, posicao), visivel = coalesce($6, visivel)
         WHERE id = $1 AND tenant_id = $2 RETURNING id, valor, rotulo, cor, posicao, visivel`,
        [req.params.id, tenant, b.rotulo?.trim().slice(0, 60) || null, b.cor ?? null,
         Number.isFinite(b.posicao) ? b.posicao : null, typeof b.visivel === "boolean" ? b.visivel : null]);
      return o ?? naoEncontrado(reply, "fase");
    });

  // ---------------- leads ----------------
  app.get<{ Querystring: { q?: string; fase?: string } }>("/api/leads", auth, async (req) => {
    const { tenant } = sessao(req);
    const p: unknown[] = [tenant];
    let w = "tenant_id = $1 AND removido_em IS NULL";
    if (req.query.q?.trim()) { p.push(req.query.q.trim()); w += ` AND (busca @@ plainto_tsquery('portuguese', $${p.length}) OR nome ILIKE '%' || $${p.length} || '%' OR cnpj LIKE $${p.length} || '%')`; }
    if (req.query.fase) { p.push(req.query.fase); w += ` AND fase = $${p.length}`; }
    return q(`SELECT ${CAMPOS_LEAD} FROM lead_juridico WHERE ${w} ORDER BY fase, posicao LIMIT 2000`, p);
  });

  app.get<{ Params: { id: string } }>("/api/leads/:id", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [l] = await q(`SELECT ${CAMPOS_LEAD}, extras FROM lead_juridico
                          WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL`, [req.params.id, tenant]);
    if (!l) return naoEncontrado(reply, "lead");
    const eventos = await q(
      `SELECT tipo, propriedades, autor_nome, aconteceu_em FROM evento_timeline
        WHERE tenant_id = $1 AND alvo_tipo = 'lead' AND alvo_id = $2
        ORDER BY aconteceu_em DESC LIMIT 100`, [tenant, req.params.id]);
    return { ...l, eventos };
  });

  /**
   * Cria lead a partir de um CNPJ devedor. Idempotente: o mesmo CNPJ duas
   * vezes devolve o lead que ja existe (409 com o id), nunca duplica.
   */
  app.post<{ Body: CorpoLead & { buscar_contatos?: boolean } }>("/api/leads", auth, async (req, reply) => {
    const { tenant, sub } = sessao(req);
    const cnpj = limparCnpj(req.body?.cnpj);
    if (cnpj && !cnpjValido(cnpj)) return reply.code(400).send({ erro: "CNPJ inválido." });

    if (cnpj) {
      const [ja] = await q<{ id: string }>(
        `SELECT id FROM lead_juridico WHERE tenant_id = $1 AND left(cnpj, 8) = $2 AND removido_em IS NULL`,
        [tenant, cnpj.slice(0, 8)]);
      if (ja) return reply.code(409).send({ erro: "Essa empresa já está nos seus leads.", id: ja.id });
    }

    const [dev] = cnpj
      ? await q<any>(`SELECT nome, uf, municipio, valor_total, tributo_principal, telefone, email
                        FROM mv_devedor WHERE cnpj_raiz = $1`, [cnpj.slice(0, 8)]).catch(() => [])
      : [];
    const cad = cnpj && req.body?.buscar_contatos !== false
      ? await consultarCadastro(cnpj).catch(() => null) : null;

    const nome = (req.body?.nome || dev?.nome || cad?.razao_social || "").trim();
    if (!nome) return reply.code(400).send({ erro: "Informe o nome ou um CNPJ que exista na base." });

    const telefones = cad?.contatos.filter((c) => c.tipo === "telefone")
      .map((c) => ({ valor: c.valor, provavel_contador: c.provavel_contador, origem: cad.fonte })) ?? [];
    const emails = cad?.contatos.filter((c) => c.tipo === "email")
      .map((c) => ({ valor: c.valor, provavel_contador: c.provavel_contador, origem: cad.fonte })) ?? [];
    if (!telefones.length && dev?.telefone) telefones.push({ valor: dev.telefone, provavel_contador: false, origem: "receita_carga" });
    if (!emails.length && dev?.email) emails.push({ valor: dev.email, provavel_contador: false, origem: "receita_carga" });

    await garantirFunil(tenant);
    const fase = req.body?.fase || "NOVO";
    const [usuario] = await q<{ nome: string }>(`SELECT nome FROM usuario WHERE id = $1`, [sub]);
    const [l] = await q<any>(
      `INSERT INTO lead_juridico (tenant_id, cnpj, nome, fase, posicao, uf, municipio, divida_total,
              tributo_principal, telefones, emails, criado_por_nome, tese_slug)
       VALUES ($1, $2, $3, $4,
               coalesce((SELECT min(posicao) - 1000 FROM lead_juridico
                          WHERE tenant_id = $1 AND fase = $4 AND removido_em IS NULL), 1000),
               $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING ${CAMPOS_LEAD}`,
      [tenant, cnpj || null, nome, fase, dev?.uf ?? cad?.endereco.uf ?? null,
       cad?.endereco.municipio ?? dev?.municipio ?? null, dev?.valor_total ?? null,
       dev?.tributo_principal ?? null, JSON.stringify(telefones), JSON.stringify(emails),
       usuario?.nome ?? null, req.body?.tese_slug || null]);
    await registrarEvento(tenant, l.id, "criado", { fase }, usuario?.nome);
    return reply.code(201).send(l);
  });

  /** Varios CNPJs de uma vez (selecao na pesquisa). Sem consulta externa: rapido. */
  app.post<{ Body: { cnpjs?: string[]; fase?: string } }>("/api/leads/lote", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const raizes = [...new Set((req.body?.cnpjs || []).map(limparCnpj).filter((c) => c.length >= 8).map((c) => c.slice(0, 8)))].slice(0, 500);
    if (!raizes.length) return reply.code(400).send({ erro: "Nenhum CNPJ válido." });
    await garantirFunil(tenant);
    const fase = req.body?.fase || "NOVO";
    const r = await q<{ id: string }>(
      `INSERT INTO lead_juridico (tenant_id, cnpj, nome, fase, posicao, uf, municipio, divida_total,
              tributo_principal, telefones, emails, criado_por_origem)
       SELECT $1, d.cnpj, d.nome, $2, 1000 + row_number() OVER (ORDER BY d.valor_total DESC),
              d.uf, d.municipio, d.valor_total, d.tributo_principal,
              CASE WHEN d.telefone IS NULL THEN '[]'::jsonb
                   ELSE jsonb_build_array(jsonb_build_object('valor', d.telefone, 'origem', 'receita_carga')) END,
              CASE WHEN d.email IS NULL THEN '[]'::jsonb
                   ELSE jsonb_build_array(jsonb_build_object('valor', d.email, 'origem', 'receita_carga')) END,
              'IMPORTACAO'
         FROM mv_devedor d
        WHERE d.cnpj_raiz = ANY($3)
          AND NOT EXISTS (SELECT 1 FROM lead_juridico l WHERE l.tenant_id = $1
                            AND left(l.cnpj, 8) = d.cnpj_raiz AND l.removido_em IS NULL)
       RETURNING id`, [tenant, fase, raizes]);
    return reply.code(201).send({ criados: r.length, ignorados: raizes.length - r.length });
  });

  app.patch<{ Params: { id: string }; Body: CorpoLead }>("/api/leads/:id", auth, async (req, reply) => {
    const { tenant, sub } = sessao(req);
    const b = req.body || {};
    const [antes] = await q<any>(`SELECT fase FROM lead_juridico WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL`,
      [req.params.id, tenant]);
    if (!antes) return naoEncontrado(reply, "lead");
    const lista = (v: unknown) => Array.isArray(v) ? JSON.stringify(v.slice(0, 20)) : null;
    const [l] = await q<any>(
      `UPDATE lead_juridico SET
         nome = coalesce($3, nome), fase = coalesce($4, fase), posicao = coalesce($5, posicao),
         telefones = coalesce($6::jsonb, telefones), emails = coalesce($7::jsonb, emails),
         etiquetas = coalesce($8, etiquetas),
         proximo_passo = CASE WHEN $9::boolean THEN $10 ELSE proximo_passo END,
         proximo_em = CASE WHEN $11::boolean THEN $12::date ELSE proximo_em END,
         probabilidade = coalesce($13, probabilidade), responsavel = coalesce($14, responsavel),
         honorario_micros = coalesce($15, honorario_micros),
         tese_slug = CASE WHEN $16::boolean THEN $17 ELSE tese_slug END,
         atualizado_em = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING ${CAMPOS_LEAD}`,
      [req.params.id, tenant, b.nome?.trim() || null, b.fase || null,
       Number.isFinite(b.posicao) ? b.posicao : null, lista(b.telefones), lista(b.emails),
       Array.isArray(b.etiquetas) ? b.etiquetas.map(String).slice(0, 20) : null,
       "proximo_passo" in b, b.proximo_passo ?? null, "proximo_em" in b, b.proximo_em || null,
       Number.isFinite(b.probabilidade) ? b.probabilidade : null, b.responsavel ?? null,
       Number.isFinite(b.honorario) ? Math.round((b.honorario as number) * 1e6) : null,
       "tese_slug" in b, b.tese_slug || null]);
    if (b.fase && b.fase !== antes.fase) {
      const [u] = await q<{ nome: string }>(`SELECT nome FROM usuario WHERE id = $1`, [sub]);
      await registrarEvento(tenant, l.id, "fase", { de: antes.fase, para: b.fase }, u?.nome);
    }
    return l;
  });

  app.delete<{ Params: { id: string } }>("/api/leads/:id", auth, async (req) => {
    await q(`UPDATE lead_juridico SET removido_em = now() WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, sessao(req).tenant]);
    return { ok: true };
  });

  /** Busca telefone/e-mail que faltam, para leads ja existentes (ate 30 por vez). */
  app.post<{ Body: { ids?: string[] } }>("/api/leads/enriquecer", auth, async (req) => {
    const { tenant } = sessao(req);
    const ids = (req.body?.ids || []).slice(0, 30);
    const alvo = await q<{ id: string; cnpj: string }>(
      `SELECT id, cnpj FROM lead_juridico
        WHERE tenant_id = $1 AND removido_em IS NULL AND cnpj IS NOT NULL
          AND (cardinality($2::uuid[]) = 0 OR id = ANY($2::uuid[]))
          AND telefones = '[]'::jsonb AND emails = '[]'::jsonb
        LIMIT 30`, [tenant, ids]);
    let achados = 0;
    for (const l of alvo) {
      const c = await consultarCadastro(l.cnpj.trim()).catch(() => null);
      if (!c) continue;
      const tel = c.contatos.filter((x) => x.tipo === "telefone").map((x) => ({ valor: x.valor, provavel_contador: x.provavel_contador, origem: c.fonte }));
      const em = c.contatos.filter((x) => x.tipo === "email").map((x) => ({ valor: x.valor, provavel_contador: x.provavel_contador, origem: c.fonte }));
      if (!tel.length && !em.length) continue;
      achados++;
      await q(`UPDATE lead_juridico SET telefones = $3, emails = $4,
                      municipio = coalesce(municipio, $5), atualizado_em = now()
                WHERE id = $1 AND tenant_id = $2`,
        [l.id, tenant, JSON.stringify(tel), JSON.stringify(em), c.endereco.municipio]);
      // A BrasilAPI limita rajadas; meio segundo entre consultas basta.
      await new Promise((r) => setTimeout(r, 500));
    }
    return { consultados: alvo.length, com_contato: achados };
  });

  /** Resumo do funil para o painel. */
  app.get("/api/leads-resumo", auth, async (req) => {
    const { tenant } = sessao(req);
    await garantirFunil(tenant);
    const fases = await q(
      `SELECT f.valor, f.rotulo, f.cor, f.posicao, count(l.id) AS leads,
              coalesce(sum(l.divida_total), 0) AS divida
         FROM funil_opcao f
         LEFT JOIN lead_juridico l ON l.tenant_id = f.tenant_id AND l.fase = f.valor AND l.removido_em IS NULL
        WHERE f.tenant_id = $1 AND f.visivel
        GROUP BY f.valor, f.rotulo, f.cor, f.posicao ORDER BY f.posicao`, [tenant]);
    const proximos = await q(
      `SELECT id, nome, proximo_passo, proximo_em, fase FROM lead_juridico
        WHERE tenant_id = $1 AND removido_em IS NULL AND proximo_em IS NOT NULL
        ORDER BY proximo_em LIMIT 8`, [tenant]);
    return { fases, proximos };
  });

}
