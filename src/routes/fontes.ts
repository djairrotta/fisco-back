import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { consultarDividaEstadual, consultarLoteEstadual, consultaEstadualConfigurada, type UfEstadual } from "../services/divida-estadual.js";

export default async function rotasFontes(app: FastifyInstance) {
  /** Estado das cargas. O painel precisa mostrar se o numero esta velho. */
  app.get("/api/fontes", async () =>
    q(`SELECT chave, rotulo, periodicidade, versao_carregada, versao_disponivel,
              ultima_sondagem, ultima_carga, falhas_seguidas, ultimo_erro
         FROM fonte_dados ORDER BY chave`));

  /** Andamento das cargas (sem dado de empresa): para acompanhar de fora. */
  app.get("/api/fontes/cargas", async () => ({
    pgfn: await q(`SELECT origem, periodo, comecou_em, terminou_em, left(erro, 300) AS erro, linhas_aceitas
                     FROM carga_etl ORDER BY comecou_em DESC NULLS LAST LIMIT 8`).catch(() => []),
    receita: await q(`SELECT periodo, etapa, status, comecou_em, terminou_em, left(erro, 300) AS erro, inseridas, atualizadas, removidas
                        FROM rfb_carga ORDER BY comecou_em DESC NULLS LAST LIMIT 8`).catch(() => []),
    historico: await q(`SELECT status, count(*) AS n, max(terminou_em) AS ultimo FROM pgfn_hist_carga GROUP BY 1`).catch(() => []),
    extras: await q(`SELECT fonte, ultima_carga, linhas, left(erro, 200) AS erro FROM fonte_extra ORDER BY fonte`).catch(() => []),
    em_execucao: await q(`SELECT left(regexp_replace(query, $$'[^']*'$$, '?', 'g'), 80) AS sql, round(extract(epoch FROM now() - query_start)) AS seg, wait_event_type
                            FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid()
                             AND query NOT ILIKE '%pg_stat_activity%' ORDER BY query_start LIMIT 6`).catch(() => []),
  }));

  /** Divida estadual sob demanda, so para assinante: cada consulta custa. */
  app.get<{ Params: { cnpj: string; uf: string } }>(
    "/api/empresas/:cnpj/divida-estadual/:uf",
    { onRequest: [(app as any).authenticate] },
    async (req, reply) => {
      const uf = req.params.uf.toUpperCase();
      if (uf !== "SP" && uf !== "MG")
        return reply.code(400).send({ erro: "Só há consulta estadual para SP e MG." });
      try {
        return await consultarDividaEstadual(req.params.cnpj, uf as UfEstadual, (req.query as any)?.forcar === "1");
      } catch (e) {
        return reply.code(400).send({ erro: e instanceof Error ? e.message : "falhou" });
      }
    });

  /**
   * Estadual em lote. A PGFN da o CNPJ; com ele se consulta a divida do
   * estado. `ufs` diz em quais estados consultar cada empresa (padrao: SP e
   * MG). Ate 100 CNPJs por chamada.
   */
  app.post<{ Body: { cnpjs?: string[]; ufs?: string[] } }>(
    "/api/divida-estadual/lote",
    { onRequest: [(app as any).authenticate] },
    async (req, reply) => {
      if (!consultaEstadualConfigurada()) {
        return reply.code(412).send({ erro: "A consulta estadual precisa do token da Infosimples configurado no servidor (INFOSIMPLES_TOKEN)." });
      }
      const ufs = (req.body?.ufs?.length ? req.body.ufs : ["SP", "MG"])
        .map((u) => u.toUpperCase()).filter((u): u is UfEstadual => u === "SP" || u === "MG");
      const cnpjs = [...new Set((req.body?.cnpjs || []).map((c) => c.toUpperCase().replace(/[^0-9A-Z]/g, "")))]
        .filter((c) => /^[0-9A-Z]{12}\d{2}$/.test(c)).slice(0, 100);
      if (!cnpjs.length) return reply.code(400).send({ erro: "Nenhum CNPJ válido." });
      const r = await consultarLoteEstadual(cnpjs.flatMap((cnpj) => ufs.map((uf) => ({ cnpj, uf }))));
      return {
        consultas: r.length,
        com_debito: r.filter((x) => x.r?.tem_debito).length,
        valor_total: r.reduce((s, x) => s + (x.r?.tem_debito ? Number(x.r.valor_total || 0) : 0), 0),
        itens: r,
      };
    });
}
