/**
 * Quadros kanban livres: planejamento, tarefas, pauta do escritorio.
 *
 * Posicao fracionaria: ao soltar um cartao entre A (posicao 1000) e
 * B (posicao 2000), o cliente manda 1500 e o servidor grava UM update.
 * Nada de reindexar a coluna inteira a cada arrasto.
 */
import type { FastifyInstance } from "fastify";
import { q, pool } from "../db/pool.js";
import { naoEncontrado, sessao } from "../lib/http.js";

const COLUNAS_PADRAO = [
  { titulo: "A fazer", cor: "slate" },
  { titulo: "Fazendo", cor: "amber" },
  { titulo: "Aguardando", cor: "sky" },
  { titulo: "Feito", cor: "emerald" },
];

const CAMPOS_CARTAO = `id, quadro_id, coluna_id, titulo, conteudo, etiquetas, vence_em,
  concluido, lead_id, posicao, criado_em, atualizado_em`;

async function doTenant(quadroId: string, tenant: string) {
  const [x] = await q(`SELECT id FROM quadro WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL`,
    [quadroId, tenant]);
  return !!x;
}

export default async function rotasQuadros(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get("/api/quadros", auth, async (req) => {
    const { tenant } = sessao(req);
    return q(
      `SELECT b.id, b.titulo, b.icone, b.posicao, b.criado_em,
              (SELECT count(*) FROM cartao c WHERE c.quadro_id = b.id AND c.removido_em IS NULL) AS cartoes,
              (SELECT count(*) FROM cartao c WHERE c.quadro_id = b.id AND c.removido_em IS NULL AND c.concluido) AS concluidos
         FROM quadro b WHERE b.tenant_id = $1 AND b.removido_em IS NULL ORDER BY b.posicao, b.criado_em`,
      [tenant]);
  });

  app.post<{ Body: { titulo?: string; icone?: string } }>("/api/quadros", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const titulo = (req.body?.titulo || "").trim().slice(0, 120) || "Novo quadro";
    const cli = await pool.connect();
    try {
      await cli.query("BEGIN");
      const { rows: [b] } = await cli.query(
        `INSERT INTO quadro (tenant_id, titulo, icone, posicao)
         VALUES ($1, $2, $3, coalesce((SELECT max(posicao) + 1000 FROM quadro WHERE tenant_id = $1), 1000))
         RETURNING id, titulo, icone, posicao, criado_em`, [tenant, titulo, req.body?.icone || null]);
      for (const [i, c] of COLUNAS_PADRAO.entries()) {
        await cli.query(`INSERT INTO quadro_coluna (quadro_id, titulo, cor, posicao) VALUES ($1,$2,$3,$4)`,
          [b.id, c.titulo, c.cor, (i + 1) * 1000]);
      }
      await cli.query("COMMIT");
      return reply.code(201).send(b);
    } catch (e) {
      await cli.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { cli.release(); }
  });

  /** Quadro inteiro: colunas e cartoes, numa ida so. */
  app.get<{ Params: { id: string } }>("/api/quadros/:id", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [b] = await q(`SELECT id, titulo, icone FROM quadro WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL`,
      [req.params.id, tenant]);
    if (!b) return naoEncontrado(reply, "quadro");
    const [colunas, cartoes] = await Promise.all([
      q(`SELECT id, titulo, cor, posicao FROM quadro_coluna WHERE quadro_id = $1 ORDER BY posicao`, [b.id]),
      q(`SELECT c.id, c.coluna_id, c.titulo, c.etiquetas, c.vence_em, c.concluido, c.lead_id, c.posicao,
                c.atualizado_em, l.nome AS lead_nome,
                jsonb_array_length(c.conteudo) > 0 AS tem_conteudo
           FROM cartao c LEFT JOIN lead_juridico l ON l.id = c.lead_id
          WHERE c.quadro_id = $1 AND c.removido_em IS NULL ORDER BY c.posicao`, [b.id]),
    ]);
    return { ...b, colunas, cartoes };
  });

  app.patch<{ Params: { id: string }; Body: { titulo?: string; icone?: string; posicao?: number } }>(
    "/api/quadros/:id", auth, async (req, reply) => {
      const { tenant } = sessao(req);
      const [b] = await q(
        `UPDATE quadro SET titulo = coalesce($3, titulo), icone = coalesce($4, icone), posicao = coalesce($5, posicao)
          WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL RETURNING id, titulo, icone, posicao`,
        [req.params.id, tenant, req.body?.titulo?.trim().slice(0, 120) || null, req.body?.icone ?? null,
         Number.isFinite(req.body?.posicao) ? req.body!.posicao : null]);
      return b ?? naoEncontrado(reply, "quadro");
    });

  app.delete<{ Params: { id: string } }>("/api/quadros/:id", auth, async (req) => {
    await q(`UPDATE quadro SET removido_em = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, sessao(req).tenant]);
    return { ok: true };
  });

  // ---------------- colunas ----------------
  app.post<{ Params: { id: string }; Body: { titulo?: string; cor?: string } }>(
    "/api/quadros/:id/colunas", auth, async (req, reply) => {
      if (!(await doTenant(req.params.id, sessao(req).tenant))) return naoEncontrado(reply, "quadro");
      const [c] = await q(
        `INSERT INTO quadro_coluna (quadro_id, titulo, cor, posicao)
         VALUES ($1, $2, $3, coalesce((SELECT max(posicao) + 1000 FROM quadro_coluna WHERE quadro_id = $1), 1000))
         RETURNING id, titulo, cor, posicao`,
        [req.params.id, (req.body?.titulo || "").trim().slice(0, 80) || "Nova coluna", req.body?.cor || "slate"]);
      return reply.code(201).send(c);
    });

  app.patch<{ Params: { id: string }; Body: { titulo?: string; cor?: string; posicao?: number } }>(
    "/api/colunas/:id", auth, async (req, reply) => {
      const [c] = await q(
        `UPDATE quadro_coluna k SET titulo = coalesce($3, k.titulo), cor = coalesce($4, k.cor),
                posicao = coalesce($5, k.posicao)
           FROM quadro b WHERE k.id = $1 AND b.id = k.quadro_id AND b.tenant_id = $2
         RETURNING k.id, k.titulo, k.cor, k.posicao`,
        [req.params.id, sessao(req).tenant, req.body?.titulo?.trim().slice(0, 80) || null,
         req.body?.cor ?? null, Number.isFinite(req.body?.posicao) ? req.body!.posicao : null]);
      return c ?? naoEncontrado(reply, "coluna");
    });

  app.delete<{ Params: { id: string } }>("/api/colunas/:id", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [n] = await q<{ n: string }>(
      `SELECT count(*) AS n FROM cartao c JOIN quadro b ON b.id = c.quadro_id
        WHERE c.coluna_id = $1 AND b.tenant_id = $2 AND c.removido_em IS NULL`, [req.params.id, tenant]);
    if (Number(n?.n) > 0) return reply.code(409).send({ erro: "Mova ou apague os cartões desta coluna antes." });
    await q(`DELETE FROM quadro_coluna k USING quadro b WHERE k.id = $1 AND b.id = k.quadro_id AND b.tenant_id = $2`,
      [req.params.id, tenant]);
    return { ok: true };
  });

  // ---------------- cartoes ----------------
  app.post<{ Params: { id: string }; Body: { coluna_id?: string; titulo?: string; lead_id?: string; posicao?: number } }>(
    "/api/quadros/:id/cartoes", auth, async (req, reply) => {
      const { tenant } = sessao(req);
      if (!(await doTenant(req.params.id, tenant))) return naoEncontrado(reply, "quadro");
      const titulo = (req.body?.titulo || "").trim().slice(0, 300);
      if (!titulo || !req.body?.coluna_id) return reply.code(400).send({ erro: "Informe título e coluna." });
      const [c] = await q(
        `INSERT INTO cartao (tenant_id, quadro_id, coluna_id, titulo, lead_id, posicao)
         SELECT $1, $2, k.id, $4, $5,
                coalesce($6, (SELECT max(posicao) + 1000 FROM cartao WHERE coluna_id = k.id AND removido_em IS NULL), 1000)
           FROM quadro_coluna k WHERE k.id = $3 AND k.quadro_id = $2
         RETURNING ${CAMPOS_CARTAO}`,
        [tenant, req.params.id, req.body.coluna_id, titulo, req.body.lead_id || null,
         Number.isFinite(req.body.posicao) ? req.body.posicao : null]);
      return c ? reply.code(201).send(c) : reply.code(400).send({ erro: "Coluna não pertence a este quadro." });
    });

  app.get<{ Params: { id: string } }>("/api/cartoes/:id", auth, async (req, reply) => {
    const [c] = await q(`SELECT ${CAMPOS_CARTAO} FROM cartao WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL`,
      [req.params.id, sessao(req).tenant]);
    return c ?? naoEncontrado(reply, "cartão");
  });

  app.patch<{ Params: { id: string }; Body: {
    titulo?: string; conteudo?: unknown; etiquetas?: string[]; vence_em?: string | null;
    concluido?: boolean; coluna_id?: string; posicao?: number; lead_id?: string | null;
  } }>("/api/cartoes/:id", auth, async (req, reply) => {
    const b = req.body || {};
    const [c] = await q(
      `UPDATE cartao c SET
         titulo = coalesce($3, c.titulo),
         conteudo = coalesce($4::jsonb, c.conteudo),
         etiquetas = coalesce($5, c.etiquetas),
         vence_em = CASE WHEN $6::boolean THEN $7::date ELSE c.vence_em END,
         concluido = coalesce($8, c.concluido),
         coluna_id = coalesce((SELECT k.id FROM quadro_coluna k WHERE k.id = $9 AND k.quadro_id = c.quadro_id), c.coluna_id),
         posicao = coalesce($10, c.posicao),
         lead_id = CASE WHEN $11::boolean THEN $12::uuid ELSE c.lead_id END,
         atualizado_em = now()
       WHERE c.id = $1 AND c.tenant_id = $2 AND c.removido_em IS NULL
       RETURNING ${CAMPOS_CARTAO.split(",").map((s) => "c." + s.trim()).join(", ")}`,
      [req.params.id, sessao(req).tenant, b.titulo?.trim().slice(0, 300) || null,
       b.conteudo === undefined ? null : JSON.stringify(b.conteudo),
       Array.isArray(b.etiquetas) ? b.etiquetas.map(String).slice(0, 12) : null,
       "vence_em" in b, b.vence_em || null, typeof b.concluido === "boolean" ? b.concluido : null,
       b.coluna_id || null, Number.isFinite(b.posicao) ? b.posicao : null,
       "lead_id" in b, b.lead_id || null]);
    return c ?? naoEncontrado(reply, "cartão");
  });

  app.delete<{ Params: { id: string } }>("/api/cartoes/:id", auth, async (req) => {
    await q(`UPDATE cartao SET removido_em = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, sessao(req).tenant]);
    return { ok: true };
  });
}
