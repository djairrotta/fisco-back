/**
 * Notas estilo Notion: paginas em arvore, conteudo em blocos (o JSON do
 * editor BlockNote), ligaveis a um lead ou a uma empresa.
 *
 * O servidor nao interpreta os blocos. Guarda o JSON como veio e, a
 * parte, o TEXTO PURO extraido pelo cliente, que e o que a busca usa.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { limparCnpj, naoEncontrado, sessao } from "../lib/http.js";

const LIMITE_CONTEUDO = 2_000_000; // ~2 MB de JSON por pagina

interface CorpoNota {
  titulo?: string; icone?: string | null; conteudo?: unknown; texto?: string;
  pai_id?: string | null; posicao?: number; favorita?: boolean;
  lead_id?: string | null; cnpj?: string | null;
}

export default async function rotasNotas(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate], bodyLimit: LIMITE_CONTEUDO + 100_000 };

  /** Arvore inteira (so metadados) para a barra lateral. */
  app.get<{ Querystring: { q?: string; lead_id?: string; cnpj?: string } }>("/api/notas", auth, async (req) => {
    const { tenant } = sessao(req);
    const p: unknown[] = [tenant];
    let w = "tenant_id = $1 AND removido_em IS NULL";
    const busca = req.query.q?.trim();
    if (busca) { p.push(busca); w += ` AND (titulo ILIKE '%' || $${p.length} || '%' OR texto ILIKE '%' || $${p.length} || '%')`; }
    if (req.query.lead_id) { p.push(req.query.lead_id); w += ` AND lead_id = $${p.length}`; }
    if (req.query.cnpj) { p.push(limparCnpj(req.query.cnpj).slice(0, 8)); w += ` AND left(cnpj, 8) = $${p.length}`; }
    return q(
      `SELECT id, pai_id, titulo, icone, favorita, posicao, lead_id, cnpj, atualizado_em,
              ${busca ? `left(texto, 160)` : "NULL"} AS trecho
         FROM nota WHERE ${w} ORDER BY posicao, criado_em LIMIT 2000`, p);
  });

  app.get<{ Params: { id: string } }>("/api/notas/:id", auth, async (req, reply) => {
    const [n] = await q(
      `SELECT n.id, n.pai_id, n.titulo, n.icone, n.conteudo, n.favorita, n.lead_id, n.cnpj,
              n.criado_em, n.atualizado_em, l.nome AS lead_nome
         FROM nota n LEFT JOIN lead_juridico l ON l.id = n.lead_id
        WHERE n.id = $1 AND n.tenant_id = $2 AND n.removido_em IS NULL`,
      [req.params.id, sessao(req).tenant]);
    return n ?? naoEncontrado(reply, "nota");
  });

  app.post<{ Body: CorpoNota }>("/api/notas", auth, async (req, reply) => {
    const { tenant, sub } = sessao(req);
    const b = req.body || {};
    if (b.pai_id) {
      const [pai] = await q(`SELECT 1 FROM nota WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL`, [b.pai_id, tenant]);
      if (!pai) return reply.code(400).send({ erro: "Página-mãe não encontrada." });
    }
    const conteudo = JSON.stringify(Array.isArray(b.conteudo) ? b.conteudo : []);
    if (conteudo.length > LIMITE_CONTEUDO) return reply.code(413).send({ erro: "Página grande demais." });
    const [n] = await q(
      `INSERT INTO nota (tenant_id, pai_id, titulo, icone, conteudo, texto, lead_id, cnpj, criado_por, posicao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               coalesce((SELECT max(posicao) + 1000 FROM nota WHERE tenant_id = $1
                          AND pai_id IS NOT DISTINCT FROM $2 AND removido_em IS NULL), 1000))
       RETURNING id, pai_id, titulo, icone, favorita, posicao, lead_id, cnpj, atualizado_em`,
      [tenant, b.pai_id || null, (b.titulo || "").slice(0, 300), b.icone || null, conteudo,
       (b.texto || "").slice(0, 200_000), b.lead_id || null,
       b.cnpj ? limparCnpj(b.cnpj).slice(0, 14) : null, sub]);
    return reply.code(201).send(n);
  });

  app.patch<{ Params: { id: string }; Body: CorpoNota }>("/api/notas/:id", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const b = req.body || {};
    // Mover para dentro de si mesma ou de um descendente criaria um ciclo
    // e a pagina sumiria da arvore.
    if (b.pai_id) {
      const [ciclo] = await q(
        `WITH RECURSIVE desc_ AS (
           SELECT id FROM nota WHERE id = $1 AND tenant_id = $3
           UNION ALL SELECT n.id FROM nota n JOIN desc_ d ON n.pai_id = d.id)
         SELECT 1 FROM desc_ WHERE id = $2`, [req.params.id, b.pai_id, tenant]);
      if (ciclo) return reply.code(400).send({ erro: "Não dá para mover uma página para dentro dela mesma." });
    }
    let conteudo: string | null = null;
    if (b.conteudo !== undefined) {
      conteudo = JSON.stringify(Array.isArray(b.conteudo) ? b.conteudo : []);
      if (conteudo.length > LIMITE_CONTEUDO) return reply.code(413).send({ erro: "Página grande demais." });
    }
    const [n] = await q(
      `UPDATE nota SET
         titulo = coalesce($3, titulo),
         icone = CASE WHEN $4::boolean THEN $5 ELSE icone END,
         conteudo = coalesce($6::jsonb, conteudo),
         texto = coalesce($7, texto),
         pai_id = CASE WHEN $8::boolean THEN $9::uuid ELSE pai_id END,
         posicao = coalesce($10, posicao),
         favorita = coalesce($11, favorita),
         lead_id = CASE WHEN $12::boolean THEN $13::uuid ELSE lead_id END,
         atualizado_em = now()
       WHERE id = $1 AND tenant_id = $2 AND removido_em IS NULL
       RETURNING id, pai_id, titulo, icone, favorita, posicao, lead_id, cnpj, atualizado_em`,
      [req.params.id, tenant, b.titulo === undefined ? null : b.titulo.slice(0, 300),
       "icone" in b, b.icone || null, conteudo,
       b.texto === undefined ? null : b.texto.slice(0, 200_000),
       "pai_id" in b, b.pai_id || null, Number.isFinite(b.posicao) ? b.posicao : null,
       typeof b.favorita === "boolean" ? b.favorita : null, "lead_id" in b, b.lead_id || null]);
    return n ?? naoEncontrado(reply, "nota");
  });

  /** Apaga a pagina e as filhas (lixeira logica). */
  app.delete<{ Params: { id: string } }>("/api/notas/:id", auth, async (req) => {
    await q(
      `WITH RECURSIVE arv AS (
         SELECT id FROM nota WHERE id = $1 AND tenant_id = $2
         UNION ALL SELECT n.id FROM nota n JOIN arv a ON n.pai_id = a.id)
       UPDATE nota SET removido_em = now() WHERE id IN (SELECT id FROM arv)`,
      [req.params.id, sessao(req).tenant]);
    return { ok: true };
  });
}
