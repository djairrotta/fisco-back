import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";

export default async function rotasMapa(app: FastifyInstance) {
  // Indice do Brasil — tambem alimenta a landing
  app.get("/api/ufs", async () => {
    return q(`SELECT uf, municipios, empresas_ativas, empresas_com_divida,
                     divida_total, data_referencia
                FROM mv_uf ORDER BY uf`);
  });

  // Municipios de um estado, ordenados por volume
  app.get<{ Params: { uf: string } }>("/api/ufs/:uf/municipios", async (req) => {
    return q(
      `SELECT municipio_ibge, municipio, empresas_ativas, empresas_com_divida,
              divida_total, divida_mediana, data_referencia
         FROM mv_municipio WHERE uf = $1
        ORDER BY divida_total DESC NULLS LAST`,
      [req.params.uf.toUpperCase()]
    );
  });

  // Ficha publica do municipio (landing) / ponto do mapa (painel)
  app.get<{ Params: { uf: string; ibge: string } }>(
    "/api/ufs/:uf/municipios/:ibge",
    async (req, reply) => {
      const uf = req.params.uf.toUpperCase();
      const [m] = await q(
        `SELECT * FROM mv_municipio WHERE uf = $1 AND municipio_ibge = $2`,
        [uf, req.params.ibge]
      );
      if (!m) return reply.code(404).send({ erro: "municipio nao encontrado" });
      const tributos = await q(
        `SELECT tributo, empresas, valor FROM mv_municipio_tributo
          WHERE uf = $1 AND municipio_ibge = $2 ORDER BY valor DESC`,
        [uf, req.params.ibge]
      );
      return { ...m, tributos };
    }
  );
}
