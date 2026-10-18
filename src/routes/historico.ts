/**
 * Serie historica da divida ativa federal por empresa (ver
 * etl/pgfn-historico.ts e sql/028).
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { limparCnpj, raizValida } from "../lib/http.js";
import { estadoHistorico, rodarHistorico } from "../etl/pgfn-historico.js";

const NEG = "NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI";

export default async function rotasHistorico(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  /** Quanto da serie ja esta carregado (por base). */
  app.get("/api/historico/estado", auth, async () => estadoHistorico());

  /**
   * Serie por trimestre (uma linha por trimestre e base), os sinais e os
   * eventos: inscricoes que entraram, que sairam e que mudaram de situacao.
   */
  app.get<{ Params: { cnpj: string } }>("/api/empresas/:cnpj/historico", auth, async (req, reply) => {
    const raiz = limparCnpj(req.params.cnpj).slice(0, 8);
    if (!raizValida(raiz)) return reply.code(400).send({ erro: "CNPJ inválido." });

    const [serie, [sinais], refs, novas, saidas, mudancas] = await Promise.all([
      q(`SELECT data_ref, origem, qtd, valor, qtd_ajuizada, valor_ajuizado, qtd_negociada, qtd_rescindida
           FROM divida_trimestre WHERE cnpj_raiz = $1 ORDER BY data_ref, origem`, [raiz]),
      q(`SELECT * FROM mv_devedor_sinais WHERE cnpj_raiz = $1`, [raiz]),
      q<{ origem: string; ultimo: string; primeiro: string }>(
        `SELECT origem, max(data_ref) FILTER (WHERE status='ok') AS ultimo,
                min(data_ref) FILTER (WHERE status='ok') AS primeiro
           FROM pgfn_hist_carga GROUP BY origem`),
      q(`SELECT h.origem, h.numero_inscricao, h.receita, h.data_inscricao, h.primeiro_ref, h.valor_primeiro,
                h.valor_ultimo, h.situacao_ultima, h.ultimo_ref
           FROM divida_historico h
           JOIN (SELECT origem, min(data_ref) FILTER (WHERE status='ok') AS primeiro
                   FROM pgfn_hist_carga GROUP BY origem) r USING (origem)
          WHERE h.cnpj_raiz = $1 AND h.primeiro_ref > r.primeiro
          ORDER BY h.primeiro_ref DESC, h.valor_primeiro DESC LIMIT 100`, [raiz]),
      q(`SELECT h.origem, h.numero_inscricao, h.receita, h.data_inscricao, h.ultimo_ref, h.valor_ultimo, h.situacao_ultima
           FROM divida_historico h
           JOIN (SELECT origem, max(data_ref) FILTER (WHERE status='ok') AS ultimo
                   FROM pgfn_hist_carga GROUP BY origem) r USING (origem)
          WHERE h.cnpj_raiz = $1 AND h.ultimo_ref < r.ultimo
          ORDER BY h.ultimo_ref DESC, h.valor_ultimo DESC LIMIT 100`, [raiz]),
      q(`SELECT origem, numero_inscricao, receita, mudou_ref, situacao_anterior, situacao_ultima, valor_ultimo,
                (situacao_ultima ~* 'RESCIND|RESCISAO' OR (coalesce(situacao_anterior,'') ~* $2 AND situacao_ultima !~* $2)) AS acordo_caiu,
                (situacao_ultima ~* $2 AND situacao_ultima !~* 'RESCIND|RESCISAO' AND coalesce(situacao_anterior,'') !~* $2) AS negociou
           FROM divida_historico
          WHERE cnpj_raiz = $1 AND mudou_ref IS NOT NULL
          ORDER BY mudou_ref DESC, valor_ultimo DESC LIMIT 100`, [raiz, NEG]),
    ]);
    return {
      serie, sinais: sinais ?? null, cobertura: refs,
      eventos: { novas, saidas, mudancas },
      aviso: "Série montada com as publicações trimestrais da PGFN (só devedor principal). O valor de cada trimestre é o consolidado publicado naquela data.",
    };
  });

  /**
   * Inscricoes de um trimestre ("Abrir"): as que estavam na lista naquela
   * data. O valor exato daquele trimestre so existe no resumo; por
   * inscricao guardamos o valor na primeira e na ultima vez em que
   * apareceu, e a tela diz isso.
   */
  app.get<{ Params: { cnpj: string }; Querystring: { ref?: string; origem?: string } }>(
    "/api/empresas/:cnpj/historico/trimestre", auth, async (req, reply) => {
      const raiz = limparCnpj(req.params.cnpj).slice(0, 8);
      const ref = req.query.ref || "";
      if (!raizValida(raiz) || !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return reply.code(400).send({ erro: "Parâmetros inválidos." });
      const itens = await q(
        `SELECT origem, numero_inscricao, receita, data_inscricao, primeiro_ref, ultimo_ref,
                valor_primeiro, valor_ultimo, situacao_ultima, situacao_primeira, ajuizado_ultimo,
                primeiro_ref = $2::date AS entrou_neste,
                ultimo_ref = $2::date AS ultima_vez_neste
           FROM divida_historico
          WHERE cnpj_raiz = $1 AND primeiro_ref <= $2::date AND ultimo_ref >= $2::date
            AND ($3::text IS NULL OR origem = $3)
          ORDER BY valor_ultimo DESC NULLS LAST LIMIT 500`, [raiz, ref, req.query.origem || null]);
      return { ref, itens };
    });

  /** Dispara a carga historica (admin). Roda em segundo plano. */
  app.post<{ Querystring: { limite?: string } }>("/api/historico/carregar", auth, async (req, reply) => {
    if ((req as any).user?.papel !== "dono") return reply.code(403).send({ erro: "Só o dono da conta." });
    void rodarHistorico(Number(req.query.limite || 0)).catch((e) => console.error("[pgfn-hist]", e));
    return { iniciado: true };
  });
}
