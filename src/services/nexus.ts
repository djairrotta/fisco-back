/**
 * Handoff para o agente de calculo tributario do NEXUS.
 * O assinante nao cria conta la: abre ordem por API e entra com JWT curto.
 */
import { request } from "undici";
import { env } from "../lib/env.js";
import { q } from "../db/pool.js";

export async function abrirOrdemCalculo(opts: {
  tenantId: string; cnpj: string; teseSlug: string; documentos?: string[];
}) {
  const r = await request(`${env.NEXUS_BASE_URL}/ordens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.NEXUS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      origem: "fisco",
      tipo: "calculo_tributario",
      tenant_externo: opts.tenantId,
      cnpj: opts.cnpj,
      tese: opts.teseSlug,
      documentos: opts.documentos ?? [],
    }),
  });
  const d: any = await r.body.json();
  const [row] = await q<{ id: string }>(
    `INSERT INTO ordem_calculo (tenant_id, cnpj, tese_slug, nexus_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [opts.tenantId, opts.cnpj, opts.teseSlug, d?.id ?? null]
  );
  return { ordemId: row.id, nexusId: d?.id, urlSso: d?.url_sso };
}

export async function concluirOrdem(nexusId: string, laudoUrl: string) {
  await q(
    `UPDATE ordem_calculo
        SET status = 'concluida', laudo_url = $2, concluida_em = now()
      WHERE nexus_id = $1`,
    [nexusId, laudoUrl]
  );
}
