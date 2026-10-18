/**
 * API publica (v1) para integrar o fisco ao sistema do escritorio:
 * pesquisa de empresas com os mesmos filtros da tela e ficha por CNPJ.
 * Autenticacao por chave (cabecalho X-Api-Key); no banco fica so o hash.
 * Chaves sao criadas/revogadas pelo dono do escritorio no painel.
 */
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { q } from "../db/pool.js";
import { numero, sessao } from "../lib/http.js";
import { montarBusca, type FiltrosBusca } from "./busca.js";

const hash = (k: string) => createHash("sha256").update(k).digest("hex");

async function tenantDaChave(req: any): Promise<string | null> {
  const k = String(req.headers["x-api-key"] || "").trim();
  if (!/^fsk_[A-Za-z0-9_-]{30,}$/.test(k)) return null;
  const [c] = await q<{ id: string; tenant_id: string }>(
    `UPDATE api_chave SET ultimo_uso = now(), usos = usos + 1 WHERE hash = $1 AND revogada_em IS NULL RETURNING id, tenant_id`, [hash(k)]);
  return c?.tenant_id ?? null;
}

const CAMPOS = `e.cnpj, e.razao_social, e.nome_fantasia, e.situacao, e.data_situacao, e.matriz, e.data_abertura,
  e.cnae_principal, e.cnae_secundarios, e.natureza_juridica, e.porte, e.capital_social, e.opcao_simples, e.opcao_mei,
  e.data_exclusao_simples, e.data_exclusao_mei, e.logradouro, e.numero, e.complemento, e.bairro, e.cep,
  e.municipio, e.municipio_ibge, e.uf, e.telefone, e.telefone2, e.email,
  coalesce(e.email_contador, false) AS email_contador, coalesce(e.telefone_contador, false) AS telefone_contador,
  (SELECT json_build_object('valor_total', d.valor_total, 'valor_ajuizado', d.valor_ajuizado, 'inscricoes', d.qtd_inscricoes,
          'tributo_principal', d.tributo_principal, 'acordos_rescindidos', d.qtd_rescindidas, 'data_referencia', d.data_referencia)
     FROM mv_devedor d WHERE d.cnpj_raiz = e.cnpj_raiz) AS divida_federal`;

export default async function rotasApiPublica(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };
  const chave = {
    config: { rateLimit: { max: 60, timeWindow: "1 minute", keyGenerator: (r: any) => String(r.headers["x-api-key"] || r.ip) } },
    onRequest: [async (req: any, reply: any) => {
      const t = await tenantDaChave(req);
      if (!t) return reply.code(401).send({ erro: "Chave de API inválida ou revogada (cabeçalho X-Api-Key)." });
      req.tenantApi = t;
    }],
  };

  // ---- gestao das chaves (painel, so o dono) ----
  app.get("/api/chaves-api", auth, async (req) => q(
    `SELECT id, nome, prefixo, criado_em, ultimo_uso, usos, revogada_em FROM api_chave WHERE tenant_id = $1 ORDER BY criado_em DESC`, [sessao(req).tenant]));
  app.post<{ Body: { nome?: string } }>("/api/chaves-api", auth, async (req, reply) => {
    const s = sessao(req);
    if (s.papel !== "dono") return reply.code(403).send({ erro: "Só o dono do escritório cria chaves." });
    const k = "fsk_" + randomBytes(24).toString("base64url");
    await q(`INSERT INTO api_chave (tenant_id, nome, prefixo, hash, criado_por) VALUES ($1, $2, $3, $4, $5)`,
      [s.tenant, String(req.body?.nome || "Integração").slice(0, 80), k.slice(0, 10), hash(k), s.sub]);
    return { chave: k, aviso: "Guarde agora: a chave não aparece de novo." };
  });
  app.delete<{ Params: { id: string } }>("/api/chaves-api/:id", auth, async (req, reply) => {
    const s = sessao(req);
    if (s.papel !== "dono") return reply.code(403).send({ erro: "Só o dono do escritório revoga chaves." });
    await q(`UPDATE api_chave SET revogada_em = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, s.tenant]);
    return { ok: true };
  });

  // ---- v1 ----
  app.get<{ Querystring: FiltrosBusca }>("/v1/empresas", chave, async (req: any) => {
    const f = req.query as FiltrosBusca;
    const { where, params } = await montarBusca(f, req.tenantApi);
    const limite = numero(f.limite, 50, 1, 100);
    const pagina = numero(f.pagina, 1, 1, 1000);
    const itens = await q(`SELECT ${CAMPOS} FROM estabelecimento e ${where}
                            ORDER BY e.pontos_contato DESC NULLS LAST, e.cnpj LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`, params);
    return { pagina, limite, itens };
  });
  app.get<{ Params: { cnpj: string } }>("/v1/empresas/:cnpj", chave, async (req, reply) => {
    const cnpj = req.params.cnpj.replace(/[^0-9A-Z]/gi, "").toUpperCase();
    const [e] = await q(`SELECT ${CAMPOS},
        (SELECT json_agg(json_build_object('nome', s.nome, 'qualificacao', s.qualificacao, 'entrada', s.entrada))
           FROM socio s WHERE s.cnpj_raiz = e.cnpj_raiz) AS socios
       FROM estabelecimento e WHERE e.cnpj = $1`, [cnpj]);
    if (!e) return reply.code(404).send({ erro: "CNPJ não encontrado na base." });
    return e;
  });
  app.get("/v1", async () => ({
    servico: "fisco API v1", autenticacao: "cabeçalho X-Api-Key",
    rotas: { "GET /v1/empresas": "pesquisa (mesmos filtros da tela: uf, municipio, cnae, situacao, regime, divida, sinal...; limite até 100, pagina)",
             "GET /v1/empresas/:cnpj": "ficha com dívida federal e sócios" },
    limite: "60 requisições por minuto por chave",
  }));
}
