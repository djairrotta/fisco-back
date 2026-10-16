/**
 * ETL da divida ativa da PGFN.
 *
 * Fonte: dadosabertos.pgfn.gov.br — CSV, gratuito, TRIMESTRAL, em tres
 * bases separadas (Geral/Sida, Previdenciaria, FGTS), cada uma dividida
 * em varios arquivos.
 *
 * DUAS ARMADILHAS QUE CUSTAM CARO:
 *  1. Somar corresponsavel duplica o valor. A propria PGFN avisa: para
 *     valor total, considerar SO o devedor principal.
 *  2. A base nao traz municipio da empresa, so UF e unidade de inscricao.
 *     O "por cidade" so existe apos o join com a base CNPJ pela raiz.
 */
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import copy from "pg-copy-streams";
import { pool } from "../db/pool.js";

const BASES = {
  PGFN_GERAL: "Dados_abertos_Nao_Previdenciario.zip",
  PGFN_PREV: "Dados_abertos_Previdenciario.zip",
  PGFN_FGTS: "Dados_abertos_FGTS.zip",
} as const;

export function normalizarTributo(receita: string): string {
  const r = (receita || "").toUpperCase();
  if (r.includes("COFINS")) return "COFINS";
  if (r.includes("PIS")) return "PIS";
  if (r.includes("IRPJ")) return "IRPJ";
  if (r.includes("CSLL")) return "CSLL";
  if (r.includes("SIMPLES")) return "Simples Nacional";
  if (r.includes("PREVID") || r.includes("INSS")) return "Contribuição Previdenciária";
  if (r.includes("FGTS")) return "FGTS";
  if (r.includes("IPI")) return "IPI";
  return "Outros";
}

export async function carregarCsv(caminho: string, origem: keyof typeof BASES, dataRef: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`CREATE TEMP TABLE stage_divida (LIKE fisco.divida_inscricao INCLUDING DEFAULTS)
                   ON COMMIT DROP`);
    const stream = c.query(copy.from(
      `COPY stage_divida (cnpj, cnpj_raiz, uf, origem, numero_inscricao, tipo_devedor,
                          tipo_situacao, situacao, receita_principal, tributo,
                          valor_consolidado, data_inscricao, unidade_origem, data_referencia)
       FROM STDIN WITH (FORMAT csv, DELIMITER ';', HEADER true, ENCODING 'LATIN1')`
    ));
    await pipeline(createReadStream(caminho), stream);
    // substitui a posicao anterior daquela origem, nao acumula trimestres
    await c.query(`DELETE FROM fisco.divida_inscricao WHERE origem = $1`, [origem]);
    await c.query(`INSERT INTO fisco.divida_inscricao SELECT * FROM stage_divida`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Baixe os CSV de https://dadosabertos.pgfn.gov.br e rode:");
  console.log("  npm run etl:pgfn -- <caminho.csv> <PGFN_GERAL|PGFN_PREV|PGFN_FGTS> <AAAA-MM-DD>");
  const [, , caminho, origem, dataRef] = process.argv;
  if (caminho && origem && dataRef) {
    await carregarCsv(caminho, origem as keyof typeof BASES, dataRef);
    console.log("carga concluida — rode npm run etl:refresh");
  }
}
