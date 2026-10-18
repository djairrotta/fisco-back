/**
 * IA na pesquisa de empresas (OpenRouter):
 *  - busca em linguagem natural ("padarias em Campinas abertas este ano com
 *    celular") vira os filtros da pesquisa;
 *  - objetivo ("quero clientes para meu escritorio de contabilidade em BH")
 *    vira 3 pesquisas prontas, cada uma com o porque;
 *  - mensagem de primeiro contato personalizada para uma empresa (e-mail ou
 *    WhatsApp), a partir do perfil comercial do escritorio.
 * Sem IA (deterministico): empresas semelhantes a uma empresa e perfil do
 * cliente ideal a partir de uma lista importada.
 *
 * A IA devolve CAMPOS; codigos CNAE e cidades sao conferidos no banco antes
 * de virar filtro. Nada que a IA invente chega ao SQL.
 */
import type { FastifyInstance } from "fastify";
import { q } from "../db/pool.js";
import { sessao } from "../lib/http.js";
import { IaIndisponivel, jsonIA } from "../services/ia.js";

const N = (t: object) => ({ anyOf: [t, { type: "null" }] });
const S = { type: "string" };
const I = { type: "integer" };
const NUM = { type: "number" };
const arr = (items: object) => ({ type: "array", items });
const en = (v: string[]) => ({ type: "string", enum: v });

const PROPS_FILTRO = {
  termo: N(S), atividades: arr(S), cnaes: arr(S), ufs: arr(S),
  cidades: arr({ type: "object", additionalProperties: false, required: ["nome", "uf"], properties: { nome: S, uf: N(S) } }),
  bairro: N(S), raio_km: N(I), habitantes_min: N(I), habitantes_max: N(I),
  porte: arr(en(["ME", "EPP", "DEMAIS"])), regime: arr(en(["mei", "simples", "demais"])),
  mei: N(en(["sim", "nao", "excluido"])), simples: N(en(["optante", "nao", "excluido"])),
  situacao: arr(en(["ativa", "baixada", "suspensa", "inapta", "nula", "todas"])),
  situacao_desde_dias: N(I), abertura_ultimos_dias: N(I), abertura_de: N(S), abertura_ate: N(S),
  idade_min: N(I), idade_max: N(I), capital_min: N(NUM), capital_max: N(NUM),
  contato: arr(en(["email", "telefone", "celular", "fixo", "site"])), ocultar_contador: { type: "boolean" },
  divida: N(en(["com", "sem"])), divida_min: N(NUM), divida_max: N(NUM),
  sinais: arr(en(["nova_tri", "nova_12m", "rescindiu", "negociou", "ajuizou", "cresceu", "caiu", "quitou", "recorrente"])),
  matriz: N(en(["matriz", "filial"])), filiais_min: N(I),
  ordem: N(en(["contatos", "recentes", "antigas", "capital_desc", "divida", "razao", "situacao"])),
};
const SCHEMA_FILTRO = { type: "object", additionalProperties: false, required: Object.keys(PROPS_FILTRO), properties: PROPS_FILTRO };

const REGRAS = `Voce converte pedidos em portugues em filtros de uma pesquisa de empresas brasileiras (base da Receita Federal + divida ativa da PGFN).
Publico: contadores e gestores procurando clientes, fornecedores ou analisando mercado.
Regras:
- atividades: termos curtos do ramo como aparecem na CNAE ("padaria", "restaurante", "contabilidade", "transporte rodoviario de carga"). cnaes: codigos CNAE 2.3 que voce tem certeza (2, 4, 5 ou 7 digitos, so numeros). Na duvida, use so atividades.
- ufs em sigla. cidades com o nome oficial e a UF quando souber.
- "abertas este ano/recentemente/novas" -> abertura_ultimos_dias (este ano = dias desde 1o de janeiro; "recem-abertas" = 90). Hoje e ${new Date().toISOString().slice(0, 10)}.
- "fechadas/baixadas" -> situacao ["baixada"] e, se houver periodo, situacao_desde_dias. Sem mencao de situacao: [] (o padrao e ativa).
- "pequenas" -> porte ["ME","EPP"]; "grandes" -> porte ["DEMAIS"] e ordem capital_desc. "MEI" -> regime ["mei"]. "sairam do Simples" -> simples "excluido". "sairam do MEI" -> mei "excluido".
- "com WhatsApp/celular" -> contato ["celular"]; "com e-mail" -> contato ["email"]. Contato do cliente final: ocultar_contador true.
- "devedoras/com divida" -> divida "com"; "dividas novas" -> sinais ["nova_tri"]; "acordo caiu/parcelamento rescindido" -> sinais ["rescindiu"].
- termo: so quando o pedido citar um nome de empresa especifico.
- Campos sem mencao: null, [] ou false. Nao invente.`;

const SIG: Record<string, string> = { ativa: "2", baixada: "8", suspensa: "3", inapta: "4", nula: "1", todas: "todas" };
const PORTE: Record<string, string> = { ME: "1", EPP: "3", DEMAIS: "5" };
const dia = (dias: number) => new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

let municipios: { ibge: string; nome: string; uf: string; chave: string }[] | null = null;
async function cidades() {
  if (!municipios) municipios = (await q<any>(`SELECT municipio_ibge AS ibge, nome, uf FROM municipio_ref`)).map((m) => ({ ...m, chave: norm(m.nome) }));
  return municipios;
}

/** Saida da IA -> filtros da pesquisa (FiltrosBusca), conferindo tudo no banco. */
export async function paraFiltros(x: any) {
  const f: Record<string, string> = {};
  const avisos: string[] = [];
  // CNAE: codigos conferidos + termos procurados na tabela
  const cods = new Set<string>();
  for (const c of (x.cnaes ?? []).map((c: string) => String(c).replace(/\D/g, "")).filter((c: string) => c.length >= 2 && c.length <= 7)) {
    const [ok] = await q(`SELECT 1 FROM cnae_ref WHERE codigo LIKE $1 || '%' LIMIT 1`, [c]);
    if (ok) cods.add(c);
  }
  for (const t of (x.atividades ?? []).slice(0, 6)) {
    const termo = norm(String(t));
    if (termo.length < 3) continue;
    const palavras = termo.split(" ").filter((p) => p.length > 2);
    const achados = await q<{ codigo: string }>(
      `SELECT codigo FROM cnae_ref
        WHERE ${palavras.map((_, i) => `translate(lower(descricao), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') LIKE '%' || $${i + 1} || '%'`).join(" AND ")}
        ORDER BY similarity(lower(descricao), $${palavras.length + 1}) DESC LIMIT 6`, [...palavras, termo]);
    if (!achados.length) avisos.push(`Atividade "${t}" não encontrada na CNAE.`);
    for (const a of achados) cods.add(a.codigo);
  }
  if (cods.size) f.cnae = [...cods].slice(0, 20).join(",");
  if (x.ufs?.length) f.uf = x.ufs.map((u: string) => u.toUpperCase()).filter((u: string) => /^[A-Z]{2}$/.test(u)).join(",");
  if (x.cidades?.length) {
    const ms = await cidades();
    const ids: string[] = [];
    for (const c of x.cidades) {
      const ch = norm(c.nome || "");
      const m = ms.find((m) => m.chave === ch && (!c.uf || m.uf === String(c.uf).toUpperCase())) ?? ms.find((m) => m.chave === ch);
      if (m) ids.push(m.ibge); else avisos.push(`Cidade "${c.nome}" não encontrada.`);
    }
    if (ids.length) { f.municipio = ids.join(","); if (f.uf && !x.raio_km) delete f.uf; }
  }
  if (x.termo) f.q = String(x.termo);
  if (x.bairro) f.bairro = String(x.bairro);
  if (x.raio_km && f.municipio) { f.raio_km = String(x.raio_km); f.raio_municipio = f.municipio.split(",")[0]; }
  if (x.habitantes_min) f.hab_min = String(x.habitantes_min);
  if (x.habitantes_max) f.hab_max = String(x.habitantes_max);
  if (x.porte?.length) f.porte = x.porte.map((p: string) => PORTE[p]).filter(Boolean).join(",");
  if (x.regime?.length) f.regime = x.regime.join(",");
  if (x.mei) f.mei = x.mei;
  if (x.simples) f.simples = x.simples;
  if (x.situacao?.length) f.situacao = x.situacao.includes("todas") ? "todas" : x.situacao.map((s: string) => SIG[s]).filter(Boolean).join(",");
  if (x.situacao_desde_dias) f.situacao_de = dia(x.situacao_desde_dias);
  if (x.abertura_ultimos_dias) f.abertura_de = dia(x.abertura_ultimos_dias);
  if (x.abertura_de && /^\d{4}-\d{2}-\d{2}$/.test(x.abertura_de)) f.abertura_de = x.abertura_de;
  if (x.abertura_ate && /^\d{4}-\d{2}-\d{2}$/.test(x.abertura_ate)) f.abertura_ate = x.abertura_ate;
  if (x.idade_min) f.idade_min = String(x.idade_min);
  if (x.idade_max) f.idade_max = String(x.idade_max);
  if (x.capital_min) f.capital_min = String(Math.round(x.capital_min));
  if (x.capital_max) f.capital_max = String(Math.round(x.capital_max));
  if (x.contato?.length) f.contato = x.contato.join(",");
  if (x.ocultar_contador) f.ocultar_contador = "1";
  if (x.divida) f.divida = x.divida;
  if (x.divida_min) f.valor_min = String(Math.round(x.divida_min));
  if (x.divida_max) f.valor_max = String(Math.round(x.divida_max));
  if (x.sinais?.length) f.sinal = x.sinais.join(",");
  if (x.matriz) f.matriz = x.matriz;
  if (x.filiais_min) f.filiais_min = String(x.filiais_min);
  if (x.ordem && x.ordem !== "contatos") f.ordem = x.ordem;
  return { filtros: f, avisos };
}

function erroIa(e: unknown, reply: any) {
  if (e instanceof IaIndisponivel) return reply.code(412).send({ erro: e.message });
  return reply.code(502).send({ erro: `A IA não respondeu: ${e instanceof Error ? e.message.slice(0, 160) : e}` });
}

export default async function rotasIa(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.post<{ Body: { texto?: string } }>("/api/ia/busca", auth, async (req, reply) => {
    const texto = String(req.body?.texto || "").trim().slice(0, 800);
    if (texto.length < 4) return reply.code(400).send({ erro: "Descreva as empresas que procura." });
    try {
      const r = await jsonIA({ nome: "filtros", sistema: REGRAS, usuario: texto,
        schema: { ...SCHEMA_FILTRO, required: [...SCHEMA_FILTRO.required, "explicacao"], properties: { ...PROPS_FILTRO, explicacao: S } } });
      const { filtros, avisos } = await paraFiltros(r.dados);
      return { filtros, avisos, explicacao: (r.dados as any).explicacao, modelo: r.modelo };
    } catch (e) { return erroIa(e, reply); }
  });

  app.post<{ Body: { texto?: string } }>("/api/ia/objetivo", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const texto = String(req.body?.texto || "").trim().slice(0, 1200);
    if (texto.length < 8) return reply.code(400).send({ erro: "Conte o objetivo (o que vende, para quem, onde)." });
    const [perfil] = await q(`SELECT oferta, publico, regiao FROM perfil_comercial WHERE tenant_id = $1`, [tenant]);
    try {
      const r = await jsonIA<any>({
        nome: "pesquisas", max_tokens: 2500, temperatura: 0.2,
        sistema: `${REGRAS}\nTarefa: a partir do objetivo do usuario, proponha 3 pesquisas DIFERENTES e complementares (ex.: empresas novas que ainda nao tem contador; empresas que perderam o Simples; devedoras com acordo rescindido). Cada uma com titulo curto, porque (1 frase: por que esse publico precisa do servico agora) e filtros.`,
        usuario: `Objetivo: ${texto}${perfil ? `\nPerfil do escritorio: oferta ${perfil.oferta ?? "-"}; publico ${perfil.publico ?? "-"}; regiao ${perfil.regiao ?? "-"}` : ""}`,
        schema: { type: "object", additionalProperties: false, required: ["pesquisas"], properties: {
          pesquisas: arr({ type: "object", additionalProperties: false, required: ["titulo", "porque", "filtros"],
            properties: { titulo: S, porque: S, filtros: SCHEMA_FILTRO } }) } },
      });
      const pesquisas = [];
      for (const p of (r.dados.pesquisas ?? []).slice(0, 4)) {
        const { filtros, avisos } = await paraFiltros(p.filtros);
        pesquisas.push({ titulo: p.titulo, porque: p.porque, filtros, avisos });
      }
      return { pesquisas, modelo: r.modelo };
    } catch (e) { return erroIa(e, reply); }
  });

  /** Semelhantes: mesma classe CNAE, mesma regiao, porte parecido. Sem IA. */
  app.get<{ Params: { cnpj: string } }>("/api/ia/semelhantes/:cnpj", auth, async (req, reply) => {
    const cnpj = req.params.cnpj.replace(/[^0-9A-Z]/gi, "").toUpperCase();
    const [e] = await q<any>(`SELECT cnae_principal, uf, municipio_ibge, porte FROM estabelecimento WHERE cnpj = $1`, [cnpj]);
    if (!e) return reply.code(404).send({ erro: "Empresa fora da base completa." });
    return {
      filtros: { cnae: String(e.cnae_principal).slice(0, 5), municipio: e.municipio_ibge, raio_km: "50", raio_municipio: e.municipio_ibge,
                 ...(e.porte ? { porte: String(e.porte) } : {}) },
      explicacao: "Mesma atividade (classe CNAE), até 50 km da cidade e mesmo porte.",
    };
  });

  /** Cliente ideal a partir de uma lista (a carteira atual): o que ela tem em comum. */
  app.get<{ Params: { id: string } }>("/api/listas/:id/perfil", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const [l] = await q<{ cnpjs: string[] }>(`SELECT cnpjs FROM lista_importada WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenant]);
    if (!l) return reply.code(404).send({ erro: "Lista não encontrada." });
    const [p] = await q<any>(`
      WITH b AS (SELECT * FROM estabelecimento WHERE cnpj = ANY($1))
      SELECT count(*) AS n,
        (SELECT json_agg(x) FROM (SELECT left(cnae_principal, 5) AS c, count(*) AS n FROM b GROUP BY 1 ORDER BY 2 DESC LIMIT 5) x) AS cnaes,
        (SELECT json_agg(x) FROM (SELECT uf AS c, count(*) AS n FROM b GROUP BY 1 ORDER BY 2 DESC LIMIT 3) x) AS ufs,
        (SELECT json_agg(x) FROM (SELECT municipio_ibge AS c, max(municipio) AS nome, count(*) AS n FROM b GROUP BY 1 ORDER BY 3 DESC LIMIT 5) x) AS municipios,
        (SELECT json_agg(x) FROM (SELECT porte AS c, count(*) AS n FROM b WHERE porte IS NOT NULL GROUP BY 1 ORDER BY 2 DESC) x) AS portes,
        (SELECT json_agg(x) FROM (SELECT CASE WHEN opcao_mei THEN 'mei' WHEN opcao_simples THEN 'simples' ELSE 'demais' END AS c, count(*) AS n FROM b GROUP BY 1 ORDER BY 2 DESC) x) AS regimes,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(year FROM age(current_date, data_abertura))) AS idade_mediana
      FROM b`, [l.cnpjs]);
    const n = Number(p.n) || 0;
    if (!n) return { n, filtros: {}, explicacao: "Nenhuma empresa da lista está na base." };
    const fortes = (xs: any[] | null, min = 0.15) => (xs ?? []).filter((x) => x.n / n >= min).map((x) => String(x.c));
    const filtros: Record<string, string> = {};
    const cn = fortes(p.cnaes); if (cn.length) filtros.cnae = cn.join(",");
    const mu = fortes(p.municipios, 0.2); if (mu.length) filtros.municipio = mu.join(","); else { const uf = fortes(p.ufs, 0.3); if (uf.length) filtros.uf = uf.join(","); }
    const po = fortes(p.portes, 0.2); if (po.length && po.length < 3) filtros.porte = po.join(",");
    const re = fortes(p.regimes, 0.25); if (re.length && re.length < 3) filtros.regime = re.join(",");
    return { n, perfil: p, filtros, explicacao: `Atividades, região, porte e regime que aparecem em pelo menos 15–30% das ${n} empresas da lista.` };
  });

  app.get("/api/perfil-comercial", auth, async (req) => {
    const { tenant } = sessao(req);
    const [p] = await q(`SELECT oferta, publico, regiao, assinatura, site, atualizado_em FROM perfil_comercial WHERE tenant_id = $1`, [tenant]);
    return p ?? null;
  });
  app.put<{ Body: { oferta?: string; publico?: string; regiao?: string; assinatura?: string; site?: string } }>("/api/perfil-comercial", auth, async (req) => {
    const { tenant } = sessao(req);
    const b = req.body ?? {};
    const t = (v?: string, n = 1500) => (v ? String(v).slice(0, n) : null);
    await q(`INSERT INTO perfil_comercial (tenant_id, oferta, publico, regiao, assinatura, site) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id) DO UPDATE SET oferta = $2, publico = $3, regiao = $4, assinatura = $5, site = $6, atualizado_em = now()`,
      [tenant, t(b.oferta), t(b.publico), t(b.regiao, 300), t(b.assinatura, 600), t(b.site, 200)]);
    return { ok: true };
  });

  /** Mensagem de primeiro contato para UMA empresa, com fatos verificados dela. */
  app.post<{ Body: { cnpj?: string; canal?: string; objetivo?: string } }>("/api/ia/mensagem", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const cnpj = String(req.body?.cnpj || "").replace(/[^0-9A-Z]/gi, "").toUpperCase();
    const canal = req.body?.canal === "whatsapp" ? "whatsapp" : "email";
    const [e] = await q<any>(
      `SELECT e.razao_social, e.nome_fantasia, e.municipio, e.uf, e.data_abertura, c.descricao AS atividade,
              CASE WHEN e.opcao_mei THEN 'MEI' WHEN e.opcao_simples THEN 'Simples Nacional' ELSE 'fora do Simples' END AS regime,
              e.data_exclusao_simples, e.data_exclusao_mei, d.valor_total, d.qtd_rescindidas, s.novas_tri
         FROM estabelecimento e LEFT JOIN cnae_ref c ON c.codigo = e.cnae_principal
         LEFT JOIN mv_devedor d ON d.cnpj_raiz = e.cnpj_raiz LEFT JOIN mv_devedor_sinais s ON s.cnpj_raiz = e.cnpj_raiz
        WHERE e.cnpj = $1`, [cnpj]).catch(() => []);
    if (!e) return reply.code(404).send({ erro: "Empresa fora da base completa." });
    const [p] = await q<any>(`SELECT oferta, publico, assinatura, site FROM perfil_comercial WHERE tenant_id = $1`, [tenant]);
    const fatos = [
      `Empresa: ${e.nome_fantasia || e.razao_social} (${e.razao_social})`, `Atividade: ${e.atividade ?? "-"}`,
      `Cidade: ${e.municipio}/${e.uf}`, `Aberta em: ${e.data_abertura ?? "-"}`, `Regime: ${e.regime}`,
      e.data_exclusao_simples && e.regime !== "Simples Nacional" ? `Excluída do Simples em ${e.data_exclusao_simples}` : null,
      e.data_exclusao_mei && e.regime !== "MEI" ? `Saiu do MEI em ${e.data_exclusao_mei}` : null,
      e.valor_total ? `Tem dívida ativa federal (dado público da PGFN)` : null,
      Number(e.qtd_rescindidas) > 0 ? "Teve parcelamento/acordo rescindido com a PGFN" : null,
      Number(e.novas_tri) > 0 ? "Teve inscrição nova em dívida ativa neste trimestre" : null,
    ].filter(Boolean).join("\n");
    try {
      const r = await jsonIA<{ assunto: string; corpo: string }>({
        nome: "mensagem", temperatura: 0.4, max_tokens: 900,
        sistema: `Voce escreve a primeira mensagem comercial de um escritorio (contabilidade, consultoria, gestao) para uma empresa, em portugues do Brasil.
Regras: ${canal === "whatsapp" ? "WhatsApp: ate 4 frases curtas, sem assunto (assunto vazio), tom cordial e direto, sem emojis em excesso." : "E-mail: assunto curto e especifico; corpo de 4 a 7 frases; uma chamada clara para responder ou marcar conversa."}
Use SO os fatos fornecidos; nao invente numeros, valores de divida ou nomes de pessoas. Cite a divida apenas de forma geral e respeitosa ("vimos que ha pendencias na divida ativa federal, que podem ser negociadas"), nunca o valor.
Nao prometa resultado. Termine com a assinatura do escritorio se houver. Inclua no fim, em linha separada, a opcao de nao receber mais mensagens.`,
        usuario: `Fatos da empresa:\n${fatos}\n\nEscritorio: ${p?.oferta ?? "servicos de contabilidade e gestao para empresas"}${p?.publico ? `\nPublico do escritorio: ${p.publico}` : ""}${p?.assinatura ? `\nAssinatura: ${p.assinatura}` : ""}${p?.site ? `\nSite: ${p.site}` : ""}${req.body?.objetivo ? `\nObjetivo desta mensagem: ${String(req.body.objetivo).slice(0, 300)}` : ""}`,
        schema: { type: "object", additionalProperties: false, required: ["assunto", "corpo"], properties: { assunto: S, corpo: S } },
      });
      return { ...r.dados, canal, modelo: r.modelo };
    } catch (e) { return erroIa(e, reply); }
  });

  /** Modelo de campanha (com variaveis), a partir do objetivo e do perfil do escritorio. */
  app.post<{ Body: { canal?: string; objetivo?: string } }>("/api/ia/modelo", auth, async (req, reply) => {
    const { tenant } = sessao(req);
    const canal = req.body?.canal === "whatsapp" ? "whatsapp" : "email";
    const [p] = await q<any>(`SELECT oferta, publico, assinatura, site FROM perfil_comercial WHERE tenant_id = $1`, [tenant]);
    try {
      const r = await jsonIA<{ assunto: string; corpo: string }>({
        nome: "modelo", temperatura: 0.5, max_tokens: 900,
        sistema: `Voce escreve um MODELO de mensagem comercial B2B em portugues do Brasil para envio a muitas empresas, de um escritorio (contabilidade, consultoria, gestao).
Use as variaveis exatamente assim quando fizer sentido: {{empresa}}, {{cidade}}, {{atividade}}, {{socio}} (primeiro nome do socio; pode estar vazio, entao use em frase que funcione sem ele, ex.: "Ola{{socio}}" NAO; prefira "Ola, tudo bem?").
${canal === "whatsapp" ? "WhatsApp: ate 4 frases curtas, assunto vazio." : "E-mail: assunto curto (pode usar {{empresa}}); corpo de 4 a 7 frases; uma chamada clara."}
Nao invente fatos da empresa nem prometa resultado. Nao inclua link de descadastro (o sistema acrescenta). Termine com a assinatura se houver.`,
        usuario: `Objetivo: ${String(req.body?.objetivo || "apresentar o escritorio e oferecer uma conversa").slice(0, 400)}
Escritorio: ${p?.oferta ?? "contabilidade e gestao para empresas"}${p?.publico ? `\nPublico: ${p.publico}` : ""}${p?.assinatura ? `\nAssinatura: ${p.assinatura}` : ""}${p?.site ? `\nSite: ${p.site}` : ""}`,
        schema: { type: "object", additionalProperties: false, required: ["assunto", "corpo"], properties: { assunto: S, corpo: S } },
      });
      return { ...r.dados, canal };
    } catch (e) { return erroIa(e, reply); }
  });
}
