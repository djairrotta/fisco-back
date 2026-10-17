/**
 * Quadro societário cruzado com a dívida de pessoa física.
 *
 * As duas direções que o advogado usa:
 *   da EMPRESA  -> quais sócios têm dívida federal própria
 *   da PESSOA   -> de quais empresas ela é sócia
 *
 * O casamento é por fragmento de CPF mais nome, porque PGFN e Receita
 * mascaram o CPF nas mesmas posições. É PROBABILÍSTICO: a resposta sempre
 * carrega `confianca` e `candidatos`, e o aviso vai junto para o cliente
 * não tratar como identidade confirmada.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";

const AVISO =
  "Vínculo inferido por fragmento de CPF (6 dígitos publicados) mais nome. " +
  "Nem a PGFN nem a Receita divulgam o CPF completo, então isto é indício, " +
  "não identificação. Confirme antes de agir.";

export default async function rotasSocios(app: FastifyInstance) {
  /** Sócios desta empresa que têm dívida federal pessoal. */
  app.get<{ Params: { cnpj: string } }>(
    "/api/empresas/:cnpj/socios-devedores",
    { onRequest: [(app as any).authenticate] },
    async (req, reply) => {
      const cnpj = (req.params.cnpj || "").replace(/\D/g, "");
      if (cnpj.length !== 14) return reply.code(400).send({ erro: "CNPJ inválido." });
      const linhas = await q(
        `SELECT nome, uf, documento, valor_total, qtd_inscricoes,
                tem_ajuizada, candidatos, confianca
           FROM mv_socio_devedor WHERE cnpj_raiz = $1
          ORDER BY valor_total DESC`, [cnpj.slice(0, 8)]
      );
      return { cnpj, socios_devedores: linhas, aviso: AVISO };
    });

  /** Empresas em que esta pessoa figura como sócia. */
  app.get<{ Params: { documento: string } }>(
    "/api/pessoas/:documento/empresas",
    { onRequest: [(app as any).authenticate] },
    async (req) => {
      const linhas = await q(
        `SELECT d.cnpj_raiz, d.qualificacao, d.entrada, d.candidatos, d.confianca,
                e.razao_social, e.municipio, e.uf AS uf_empresa
           FROM mv_socio_devedor d
           LEFT JOIN estabelecimento e
                  ON e.cnpj_raiz = d.cnpj_raiz AND e.matriz
          WHERE d.documento = $1
          ORDER BY d.entrada NULLS LAST`, [req.params.documento]
      );
      return { documento: req.params.documento, empresas: linhas, aviso: AVISO };
    });

  /** Busca de devedor pessoa física por nome. */
  app.get<{ Querystring: { nome?: string; uf?: string } }>(
    "/api/pessoas",
    { onRequest: [(app as any).authenticate] },
    async (req, reply) => {
      const nome = (req.query.nome || "").trim();
      if (nome.length < 4) return reply.code(400).send({ erro: "Informe ao menos 4 letras do nome." });
      const linhas = await q(
        `SELECT documento, nome, uf, valor_total, qtd_inscricoes, tem_ajuizada
           FROM mv_divida_pessoa
          WHERE nome_chave(nome) LIKE '%' || nome_chave($1) || '%'
            AND ($2 = '' OR uf = $2)
          ORDER BY valor_total DESC LIMIT 50`,
        [nome, (req.query.uf || "").toUpperCase()]
      );
      return { pessoas: linhas, aviso: AVISO };
    });
}
