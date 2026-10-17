import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { consultarDividaEstadual, type UfEstadual } from "../services/divida-estadual.js";

export default async function rotasFontes(app: FastifyInstance) {
  /** Estado das cargas. O painel precisa mostrar se o numero esta velho. */
  app.get("/api/fontes", async () =>
    q(`SELECT chave, rotulo, periodicidade, versao_carregada, versao_disponivel,
              ultima_sondagem, ultima_carga, falhas_seguidas, ultimo_erro
         FROM fonte_dados ORDER BY chave`));

  /** Divida estadual sob demanda, so para assinante: cada consulta custa. */
  app.get<{ Params: { cnpj: string; uf: string } }>(
    "/api/empresas/:cnpj/divida-estadual/:uf",
    { onRequest: [(app as any).authenticate] },
    async (req, reply) => {
      const uf = req.params.uf.toUpperCase();
      if (uf !== "SP" && uf !== "MG")
        return reply.code(400).send({ erro: "Só há consulta estadual para SP e MG." });
      try {
        return await consultarDividaEstadual(req.params.cnpj, uf as UfEstadual);
      } catch (e) {
        return reply.code(400).send({ erro: e instanceof Error ? e.message : "falhou" });
      }
    });
}
