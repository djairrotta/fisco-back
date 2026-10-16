/**
 * Descoberta e enriquecimento de processos.
 *
 * O ENCADEAMENTO QUE FAZ ISSO FUNCIONAR:
 *   1. iAndamento busca por CNPJ/CPF  -> devolve os numeros de processo
 *   2. DataJud busca pelo numero      -> classe, assunto, orgao, valor,
 *                                        e a linha do tempo de movimentos
 *
 * Sem o passo 1 nao ha descoberta: a API publica do DataJud nao expoe nome
 * de parte por politica de protecao de dados do CNJ, entao ela so responde
 * a quem JA tem o numero. O iAndamento e a ponte.
 */
import { request } from "undici";
import { env } from "../lib/env.js";
import { q } from "../db/pool.js";

const TRIBUNAL_ENDPOINT = (t: string) =>
  `https://api-publica.datajud.cnj.jus.br/api_publica_${t.toLowerCase()}/_search`;

export async function descobrirProcessos(documento: string, tenantId: string) {
  const r = await request(`${env.IANDAMENTO_BASE_URL}/processos/por-documento`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.IANDAMENTO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documento }),
  });
  if (r.statusCode !== 200) return [];
  const d: any = await r.body.json();
  const achados: any[] = d?.processos ?? [];

  for (const p of achados) {
    await q(
      `INSERT INTO processo (numero_cnj, cnpj, cnpj_raiz, tribunal, polo,
                             descoberto_por, fonte, confianca)
       VALUES ($1,$2,$3,$4,$5,'iandamento','iandamento',95)
       ON CONFLICT (numero_cnj) DO UPDATE SET
         cnpj = COALESCE(processo.cnpj, EXCLUDED.cnpj),
         descoberto_por = 'iandamento',
         atualizado_em = now()`,
      [p.numero, documento.length === 14 ? documento : null,
       documento.length === 14 ? documento.slice(0, 8) : null,
       p.tribunal ?? null, p.polo ?? null]
    );
  }
  return achados;
}

/** Passo 2: metadados e linha do tempo completa pelo numero. */
export async function enriquecerPeloDataJud(numeroCnj: string, tribunal: string) {
  const r = await request(TRIBUNAL_ENDPOINT(tribunal), {
    method: "POST",
    headers: {
      Authorization: `APIKey ${env.DATAJUD_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { match: { numeroProcesso: numeroCnj.replace(/\D/g, "") } } }),
  });
  if (r.statusCode !== 200) return null;
  const d: any = await r.body.json();
  const h = d?.hits?.hits?.[0]?._source;
  if (!h) return null;

  await q(
    `UPDATE processo SET
       classe = $2, assunto = $3, orgao_julgador = $4, valor_causa = $5,
       distribuido_em = $6, grau = $7, sistema = $8, nivel_sigilo = $9,
       assuntos = $10, enriquecido_em = now(), atualizado_em = now()
     WHERE numero_cnj = $1`,
    [numeroCnj, h.classe?.nome ?? null, h.assuntos?.[0]?.nome ?? null,
     h.orgaoJulgador?.nome ?? null, h.valorCausa ?? null,
     h.dataAjuizamento ?? null, h.grau ?? null, h.sistema?.nome ?? null,
     h.nivelSigilo ?? null, JSON.stringify(h.assuntos ?? [])]
  );

  // A linha do tempo e o que o advogado realmente olha.
  for (const m of h.movimentos ?? []) {
    await q(
      `INSERT INTO processo_movimento (numero_cnj, codigo, nome, data_hora, complementos)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (numero_cnj, codigo, data_hora) DO NOTHING`,
      [numeroCnj, m.codigo ?? null, m.nome ?? null, m.dataHora,
       JSON.stringify(m.complementosTabelados ?? [])]
    );
  }
  return h;
}

/** Fluxo completo: um CNPJ entra, processos com linha do tempo saem. */
export async function dossieProcessual(documento: string, tenantId: string) {
  const achados = await descobrirProcessos(documento, tenantId);
  for (const p of achados) {
    if (p.numero && p.tribunal) {
      try { await enriquecerPeloDataJud(p.numero, p.tribunal); } catch { /* segue */ }
    }
  }
  return q(
    `SELECT p.*,
            (SELECT json_agg(m ORDER BY m.data_hora DESC)
               FROM processo_movimento m WHERE m.numero_cnj = p.numero_cnj) AS movimentos
       FROM processo p
      WHERE p.cnpj = $1 OR p.cnpj_raiz = left($1, 8)
      ORDER BY p.distribuido_em DESC NULLS LAST`,
    [documento]
  );
}
