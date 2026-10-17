import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";

export default async function rotasTeses(app: FastifyInstance) {
  app.get("/api/teses", async () => {
    // Tese derrotada nunca aparece no mapa, mas continua visivel no banco
    // de teses com o selo — o advogado precisa saber que ela caiu.
    return q(`SELECT slug, nome, tributo, maturidade, fundamento_legal,
                     verificada_em, checklist_docs, tributos_divida
                FROM tese WHERE ativa ORDER BY maturidade, nome`);
  });

  app.get<{ Params: { slug: string } }>("/api/teses/:slug", async (req, reply) => {
    const [t] = await q(`SELECT * FROM tese WHERE slug = $1`, [req.params.slug]);
    if (!t) return reply.code(404).send({ erro: "tese nao encontrada" });
    const hist = await q(
      `SELECT de, para, motivo, registrado_em FROM tese_historico_maturidade
        WHERE tese_slug = $1 ORDER BY registrado_em DESC LIMIT 20`,
      [req.params.slug]
    );
    return { ...t, historico: hist };
  });

  // Oportunidades: a chamada central do produto
  app.get<{ Params: { slug: string }; Querystring: { uf: string; ibge?: string } }>(
    "/api/teses/:slug/oportunidades",
    async (req, reply) => {
      const { uf, ibge } = req.query;
      if (!uf) return reply.code(400).send({ erro: "uf obrigatoria" });
      return q(`SELECT * FROM score_tese($1, $2, $3)`,
        [req.params.slug, uf.toUpperCase(), ibge ?? null]);
    }
  );
}
