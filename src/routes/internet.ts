/**
 * Pesquisa da empresa na internet pelo servico Jev (fiscojev).
 *
 * O Jev abre um navegador, acha o site da propria empresa e a pagina de
 * contato; telefone e e-mail so voltam se estiverem escritos numa pagina
 * visitada, com a URL de onde saiu. Nao preenche formulario nem envia nada.
 *
 * Resultado em cache por CNPJ (30 dias). Pesquisa nova so com ?forcar=1.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { cnpjValido, limparCnpj, sessao } from "../lib/http.js";
import { consultarCadastro } from "../services/cadastro.js";

const URL = () => (process.env.JEV_SERVICE_URL || "").replace(/\/$/, "");
const CHAVE = () => process.env.JEV_SERVICE_KEY || "";
const VALIDADE_DIAS = 30;

/** "METALURGICA EXEMPLO LTDA - ME" -> "METALURGICA EXEMPLO": buscador acha melhor sem o sufixo. */
export function termoDeBusca(razao: string | null, fantasia: string | null) {
  const limpa = (s: string) => s.replace(/\b(LTDA|EIRELI|S\.?\/?A\.?|EPP|ME|MEI|SOCIEDADE LIMITADA|EM RECUPERACAO JUDICIAL)\b\.?/gi, " ")
    .replace(/[-–,.]+\s*$/g, "").replace(/\s+/g, " ").trim();
  const f = fantasia && !/^\*+$/.test(fantasia.trim()) ? limpa(fantasia) : "";
  return f.length >= 3 ? f : limpa(razao || "");
}

export default async function rotasInternet(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get("/api/internet/estado", auth, async () => {
    if (!URL()) return { configurado: false, motivo: "JEV_SERVICE_URL não configurado no backend." };
    try {
      const r = await fetch(URL() + "/health", { signal: AbortSignal.timeout(4000) });
      const h = await r.json();
      return { configurado: !!(h.modelo && h.navegador === "ok"), ...h,
               motivo: !h.modelo ? "Falta TEXT_MODEL_API_KEY (OpenRouter) no serviço fiscojev." : h.navegador !== "ok" ? "Navegador do serviço fora do ar." : null };
    } catch {
      return { configurado: false, motivo: "Serviço de pesquisa (fiscojev) fora do ar." };
    }
  });

  app.get<{ Params: { cnpj: string } }>("/api/empresas/:cnpj/internet", auth, async (req, reply) => {
    const cnpj = limparCnpj(req.params.cnpj);
    if (!cnpjValido(cnpj)) return reply.code(400).send({ erro: "CNPJ inválido." });
    const [r] = await q(`SELECT dados, status, criado_em FROM fisco.pesquisa_web WHERE cnpj = $1`, [cnpj]);
    return r ?? null;
  });

  app.post<{ Params: { cnpj: string }; Querystring: { forcar?: string } }>(
    "/api/empresas/:cnpj/internet", auth, async (req, reply) => {
      const cnpj = limparCnpj(req.params.cnpj);
      if (!cnpjValido(cnpj)) return reply.code(400).send({ erro: "CNPJ inválido." });
      if (!URL() || !CHAVE()) return reply.code(412).send({ erro: "A pesquisa na internet precisa do serviço fiscojev configurado (JEV_SERVICE_URL e JEV_SERVICE_KEY)." });

      if (req.query.forcar !== "1") {
        const [r] = await q(`SELECT dados, status, criado_em FROM fisco.pesquisa_web
                              WHERE cnpj = $1 AND criado_em > now() - make_interval(days => $2)`, [cnpj, VALIDADE_DIAS]);
        if (r) return { ...r, cache: true };
      }

      const c = await consultarCadastro(cnpj).catch(() => null);
      const [d] = c?.razao_social ? [null] : await q<{ nome: string; uf: string }>(
        `SELECT nome, uf FROM mv_devedor WHERE cnpj_raiz = $1`, [cnpj.slice(0, 8)]).catch(() => []);
      const nome = c?.razao_social || d?.nome;
      if (!nome) return reply.code(404).send({ erro: "Sem razão social para pesquisar." });
      const corpo = {
        nome, fantasia: c?.nome_fantasia || null, cnpj,
        busca: termoDeBusca(nome, c?.nome_fantasia ?? null),
        municipio: c?.endereco.municipio || null, uf: c?.endereco.uf || d?.uf || null,
      };

      let r: Response;
      try {
        r = await fetch(URL() + "/pesquisar", {
          method: "POST", headers: { "content-type": "application/json", "x-chave": CHAVE() },
          body: JSON.stringify(corpo), signal: AbortSignal.timeout(150_000),
        });
      } catch {
        return reply.code(503).send({ erro: "Serviço de pesquisa (fiscojev) não respondeu." });
      }
      const dados = await r.json().catch(() => ({ erro: "resposta inválida do serviço" }));
      if (!r.ok) return reply.code(r.status === 429 ? 429 : r.status === 412 ? 412 : 502).send({ erro: dados.erro || `falhou (${r.status})` });

      const status = dados.status_navegacao || "done";
      const [salvo] = await q(
        `INSERT INTO fisco.pesquisa_web (cnpj, dados, status) VALUES ($1, $2, $3)
         ON CONFLICT (cnpj) DO UPDATE SET dados = EXCLUDED.dados, status = EXCLUDED.status, criado_em = now()
         RETURNING dados, status, criado_em`, [cnpj, JSON.stringify({ ...dados, consulta: corpo }), status]);
      return { ...salvo, cache: false };
    });

  /**
   * Leva os contatos achados para o lead que ja existe (nao cria lead).
   * Mescla sem duplicar e marca a origem e a URL de onde saiu.
   */
  app.post<{ Params: { cnpj: string } }>("/api/empresas/:cnpj/internet/para-lead", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const cnpj = limparCnpj(req.params.cnpj);
    const [p] = await q<{ dados: any }>(`SELECT dados FROM fisco.pesquisa_web WHERE cnpj = $1`, [cnpj]);
    if (!p) return reply.code(404).send({ erro: "Pesquise na internet antes." });
    const [lead] = await q<{ id: string; telefones: any[]; emails: any[]; extras: any }>(
      `SELECT id, telefones, emails, extras FROM lead_juridico
        WHERE tenant_id = $1 AND left(cnpj, 8) = $2 AND removido_em IS NULL LIMIT 1`, [tenant, cnpj.slice(0, 8)]);
    if (!lead) return reply.code(404).send({ erro: "Esta empresa ainda não é lead." });

    const fonte = (campo: string, valor: string) =>
      (p.dados.evidencias || []).find((e: any) => e.campo === campo && e.valor === valor)?.url ?? null;
    const mesclar = (atual: any[], novos: string[], campo: string) => {
      const chave = (v: string) => campo === "telefone" ? String(v).replace(/\D/g, "") : String(v).toLowerCase();
      const ja = new Set(atual.map((x) => chave(x.valor)));
      const add = novos.filter((v) => !ja.has(chave(v)))
        .map((valor) => ({ valor, origem: "internet", url: fonte(campo, valor), provavel_contador: false }));
      return { lista: [...atual, ...add], n: add.length };
    };
    const t = mesclar(lead.telefones || [], p.dados.telefones || [], "telefone");
    const e = mesclar(lead.emails || [], p.dados.emails || [], "email");
    const extras = { ...(lead.extras || {}), ...Object.fromEntries(
      ["site", "instagram", "facebook", "linkedin", "whatsapp"].filter((k) => p.dados[k]).map((k) => [k, p.dados[k]])) };
    await q(`UPDATE lead_juridico SET telefones = $3, emails = $4, extras = $5, atualizado_em = now()
              WHERE id = $1 AND tenant_id = $2`,
      [lead.id, tenant, JSON.stringify(t.lista), JSON.stringify(e.lista), JSON.stringify(extras)]);
    return { lead_id: lead.id, telefones_novos: t.n, emails_novos: e.n };
  });
}
