import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { preencher } from "../services/preenchimento.js";

export default async function rotasPecas(app: FastifyInstance) {
  app.post<{ Body: { cnpj: string; tese: string; ficha: string } }>(
    "/api/pecas",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      const tenantId = (req.user as any).tenantId;
      const [t] = await q<{ plano: string; pecas_mes: number; pecas_usadas: number }>(
        `SELECT plano, pecas_mes, pecas_usadas FROM tenant WHERE id = $1`, [tenantId]
      );
      if (!t) return reply.code(403).send({ erro: "tenant invalido" });
      if (t.plano !== "com_ia") {
        return reply.code(402).send({
          erro: "plano_sem_ia",
          mensagem: "A geracao de pecas exige o plano com IA.",
        });
      }
      if (t.pecas_usadas >= t.pecas_mes) {
        return reply.code(429).send({
          erro: "cota_excedida",
          mensagem: `Limite de ${t.pecas_mes} pecas no ciclo atingido.`,
        });
      }

      const r = await preencher(req.body.ficha);
      const campos = r.campos as any;

      const [p] = await q<{ id: string }>(
        `INSERT INTO peca (tenant_id, cnpj, tese_slug, campos, modelo_ia,
                           tokens_in, tokens_out, custo_usd,
                           exige_revisao, motivo_revisao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [tenantId, req.body.cnpj, req.body.tese, campos, r.modelo,
         r.tokensIn, r.tokensOut, r.custoUsd,
         campos.exige_analise_advogado === true, campos.motivo_analise ?? null]
      );
      await q(`UPDATE tenant SET pecas_usadas = pecas_usadas + 1 WHERE id = $1`, [tenantId]);

      // O campo que a medicao mostrou ser o unico fraco. Nunca e
      // escondido: vai para a interface como bloqueio visivel.
      return {
        id: p.id,
        campos,
        exige_revisao: campos.exige_analise_advogado === true,
        motivo: campos.motivo_analise,
        aviso: "Campos vazios sao propositais: o modelo nao inventa dado ausente. Confira antes de protocolar.",
      };
    }
  );
}
