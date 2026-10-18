/**
 * Listas importadas: o usuario cola (ou sobe um CSV/TXT) uma lista de CNPJs
 * -- clientes, prospects de outra fonte -- e a pesquisa de empresas passa a
 * filtrar por ela (?lista=<id>), com todos os filtros e a exportacao.
 * Raiz de 8 digitos vira o CNPJ da matriz (0001 + digitos verificadores).
 *
 * Enriquecer: poe as empresas da lista na fila do Jev (pesquisa na
 * internet, uma por vez, com teto diario). O resultado aparece na ficha e
 * pode ir para o lead.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { sessao } from "../lib/http.js";
import { jevConfigurado, pesquisarNaInternet } from "./internet.js";

const MAX = 50_000;
const val = (c: string) => c.charCodeAt(0) - 48;

/** Digitos verificadores do CNPJ (numerico ou alfanumerico). */
export function dvCnpj(base12: string) {
  const calc = (s: string, pesos: number[]) => {
    const t = s.split("").reduce((a, c, i) => a + val(c) * pesos[i], 0) % 11;
    return t < 2 ? 0 : 11 - t;
  };
  const d1 = calc(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${d1}${d2}`;
}

/** Tira CNPJs (com ou sem pontuacao) e raizes de um texto qualquer. */
export function extrairCnpjs(texto: string) {
  const achados = new Set<string>();
  let invalidos = 0;
  const tokens = texto.toUpperCase().match(/[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}(?:\/?[0-9A-Z]{4}-?\d{2})?/g) ?? [];
  for (const t of tokens) {
    const c = t.replace(/[^0-9A-Z]/g, "");
    if (!/\d/.test(c)) continue;
    if (c.length === 14) {
      if (/^[0-9A-Z]{12}\d{2}$/.test(c) && dvCnpj(c.slice(0, 12)) === c.slice(12)) achados.add(c); else invalidos++;
    } else if (c.length === 8 && /^\d{8}$/.test(c)) {
      const b = c + "0001";
      achados.add(b + dvCnpj(b));
    }
  }
  return { cnpjs: [...achados].slice(0, MAX), invalidos };
}

const DIA = () => Number(process.env.JEV_FILA_DIA || 300);

/** Processa a fila do Jev: uma empresa por vez, com teto diario. */
export function iniciarFilaInternet() {
  let ocupado = false;
  const passo = async () => {
    if (ocupado) return;
    ocupado = true;
    try {
      const [{ hoje }] = await q<{ hoje: string }>(
        `SELECT count(*) AS hoje FROM fila_internet WHERE feito_em > date_trunc('day', now())`);
      if (Number(hoje) >= DIA()) return;
      const [item] = await q<{ tenant_id: string; cnpj: string }>(
        `UPDATE fila_internet SET tentativas = tentativas + 1
          WHERE (tenant_id, cnpj) = (SELECT tenant_id, cnpj FROM fila_internet WHERE status = 'pendente'
                                      ORDER BY criado_em LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING tenant_id, cnpj`);
      if (!item) return;
      if (!(await jevConfigurado())) {
        await q(`UPDATE fila_internet SET tentativas = tentativas - 1 WHERE tenant_id = $1 AND cnpj = $2`, [item.tenant_id, item.cnpj]);
        return;
      }
      const r = await pesquisarNaInternet(item.cnpj);
      const erro = "erro" in r ? r.erro : null;
      await q(`UPDATE fila_internet SET status = $3, erro = $4, feito_em = now()
                WHERE tenant_id = $1 AND cnpj = $2`, [item.tenant_id, item.cnpj, erro ? "erro" : "feito", erro]);
    } catch (e) {
      console.error("[fila-internet]", e instanceof Error ? e.message : e);
    } finally { ocupado = false; }
  };
  setInterval(() => void passo(), 20_000).unref();
}

export default async function rotasListas(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get("/api/listas", auth, async (req) => {
    const { tenant } = sessao(req);
    return q(`SELECT l.id, l.nome, cardinality(l.cnpjs) AS total, l.invalidos, l.criado_em,
                     (SELECT count(*) FROM fila_internet f WHERE f.lista_id = l.id AND f.status = 'pendente') AS fila_pendente,
                     (SELECT count(*) FROM fila_internet f WHERE f.lista_id = l.id AND f.status = 'feito') AS fila_feito
                FROM lista_importada l WHERE l.tenant_id = $1 ORDER BY l.criado_em DESC LIMIT 100`, [tenant]);
  });

  app.post<{ Body: { nome?: string; texto?: string } }>("/api/listas", auth, async (req, reply) => {
    const { tenant, sub } = sessao(req);
    const { cnpjs, invalidos } = extrairCnpjs(String(req.body?.texto || "").slice(0, 5_000_000));
    if (!cnpjs.length) return reply.code(400).send({ erro: "Nenhum CNPJ válido no texto.", invalidos });
    const nome = (req.body?.nome || "").trim().slice(0, 120) || `Lista de ${new Date().toLocaleDateString("pt-BR")}`;
    const [l] = await q(`INSERT INTO lista_importada (tenant_id, nome, cnpjs, invalidos, criado_por)
                         VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, cardinality(cnpjs) AS total, invalidos`,
      [tenant, nome, cnpjs, invalidos, sub]);
    const [{ achados }] = await q<{ achados: string }>(
      `SELECT count(*) AS achados FROM estabelecimento WHERE cnpj = ANY($1)`, [cnpjs]);
    return { ...l, na_base: Number(achados) };
  });

  app.delete<{ Params: { id: string } }>("/api/listas/:id", auth, async (req) => {
    const { tenant } = sessao(req);
    await q(`DELETE FROM lista_importada WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant]);
    return { ok: true };
  });

  /** Enfileira a lista (ou CNPJs avulsos) para pesquisa na internet. */
  app.post<{ Params: { id: string }; Body: { cnpjs?: string[] } }>("/api/listas/:id/enriquecer", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [l] = await q<{ cnpjs: string[] }>(`SELECT cnpjs FROM lista_importada WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant]);
    if (!l) return reply.code(404).send({ erro: "Lista não encontrada." });
    const r = await q(`INSERT INTO fila_internet (tenant_id, cnpj, lista_id)
                       SELECT $1, c, $2 FROM unnest($3::text[]) c
                        WHERE NOT EXISTS (SELECT 1 FROM pesquisa_web w WHERE w.cnpj = c AND w.criado_em > now() - interval '30 days')
                       ON CONFLICT (tenant_id, cnpj) DO UPDATE SET status = 'pendente', lista_id = EXCLUDED.lista_id
                        WHERE fila_internet.status = 'erro'
                       RETURNING cnpj`, [tenant, req.params.id, l.cnpjs]);
    return { enfileiradas: r.length, por_dia: DIA(), configurado: await jevConfigurado() };
  });

  app.get("/api/fila-internet", auth, async (req) => {
    const { tenant } = sessao(req);
    const [r] = await q(`SELECT count(*) FILTER (WHERE status = 'pendente') AS pendentes,
                                count(*) FILTER (WHERE status = 'feito') AS feitas,
                                count(*) FILTER (WHERE status = 'erro') AS erros,
                                count(*) FILTER (WHERE feito_em > date_trunc('day', now())) AS hoje
                           FROM fila_internet WHERE tenant_id = $1`, [tenant]);
    return { ...r, por_dia: DIA(), configurado: await jevConfigurado() };
  });
}
