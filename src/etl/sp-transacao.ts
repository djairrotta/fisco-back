/**
 * Divida estadual de SP publicada em lote: a base de TRANSACAO da PGE-SP
 * (Dados Abertos SP, conjunto "Divida Ativa do Estado de Sao Paulo").
 *
 * O que ela e: quem aderiu a transacao tributaria estadual (ICMS, IPVA,
 * ITCMD, multas), com o status do acordo (em andamento, pago, ROMPIDO) e os
 * valores com e sem desconto. O que ela NAO e: a lista de todos os devedores
 * do estado -- SP nao publica essa lista. Para o advogado o recorte vale
 * muito: empresa com acordo rompido tem ICMS inscrito e acabou de perder o
 * beneficio.
 *
 * Planilha com uma aba por edital, cada uma com cabecalho diferente (a
 * coluna do documento chama CPF_CNPJ, a do nome NOME ou CONTRIBUINTE, os
 * valores mudam de nome). Por isso a leitura e pelo nome da coluna.
 * Linhas de pessoa fisica (sem CNPJ) ficam de fora.
 */
import ExcelJS from "exceljs";
import { pool } from "../db/pool.js";

const URL_PADRAO = "https://dadosabertos.sp.gov.br/dataset/1a4457ad-1a4d-4090-82d5-d10c3b1ddbed/resource/9a4385bf-3b92-40a9-9f3c-f2e87f72e4e4/download/dados_da_transacao_-_janeiro.2025.xlsx";
const POSICAO_PADRAO = "2025-01-31";

const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

function valor(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const n = Number(String(v).replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function data(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && v > 20000 && v < 80000) {       // serial do Excel
    return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10);
  }
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** CNPJ da celula. A planilha perde o zero a esquerda (6194010000353). */
export function cnpjDaCelula(v: unknown): string | null {
  const s = String(v ?? "").trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (/^\d{13,14}$/.test(s)) return s.padStart(14, "0");
  if (/^[0-9A-Z]{12}\d{2}$/.test(s)) return s;
  return null;
}

export async function carregarTransacaoSp(url = process.env.SP_TRANSACAO_URL ?? URL_PADRAO,
                                          posicao = process.env.SP_TRANSACAO_POSICAO ?? POSICAO_PADRAO) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download da base de SP falhou: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);

  const linhas: unknown[][] = [];
  for (const ws of wb.worksheets) {
    // O cabecalho nao esta na linha 1 (ha uma linha vazia antes): procura a
    // primeira linha que tenha a coluna do documento ou do nome.
    let cab: string[] | null = null;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = (row.values as unknown[]).slice(1);
      if (!cab) {
        const n = vals.map(norm);
        if (n.includes("CPF_CNPJ") || n.includes("NOME") || n.includes("CONTRIBUINTE")) cab = n;
        return;
      }
      const d: Record<string, unknown> = {};
      cab.forEach((c, i) => { d[c] = (vals[i] as any)?.result ?? vals[i]; });
      const cnpj = cnpjDaCelula(d.CPF_CNPJ);
      if (!cnpj) return;
      linhas.push([
        cnpj, cnpj.slice(0, 8), String(d.NOME ?? d.CONTRIBUINTE ?? "").trim() || null, ws.name.trim(),
        d.SOLICITACAO == null ? null : String(d.SOLICITACAO),
        String(d.STATUS_PTE ?? d.STATUS_SOL ?? "").trim() || null,
        String(d.TIPO_DEBITO ?? "").trim() || null,
        Number(d.QTDE_DEBITOS ?? d.QTDE_DEBITO ?? d.QTD_DEBITOS) || null,
        Number(d.QTD_PARCELAS) || null,
        valor(d.VALOR_SEM_BENEFICIOS ?? d.SEM_BENEFICIOS ?? d.VALOR_SB),
        valor(d.VALOR_COM_BENEFICIOS ?? d.COM_BENEFICIOS ?? d.VALOR_CB),
        data(d.DATA_SOLICITACAO ?? d.DATA_ADESAO),
        posicao,
      ]);
    });
  }

  const cli = await pool.connect();
  try {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL statement_timeout = 0");
    await cli.query(`DELETE FROM fisco.estadual_transacao_sp`);
    for (let i = 0; i < linhas.length; i += 1000) {
      const lote = linhas.slice(i, i + 1000);
      const ph = lote.map((_, j) => `(${Array.from({ length: 13 }, (_, k) => `$${j * 13 + k + 1}`).join(",")})`).join(",");
      await cli.query(
        `INSERT INTO fisco.estadual_transacao_sp (cnpj, cnpj_raiz, nome, edital, solicitacao, status, tipo_debito,
                qtd_debitos, qtd_parcelas, valor_sem_beneficio, valor_com_beneficio, data_solicitacao, posicao)
         VALUES ${ph}`, lote.flat());
    }
    await cli.query("COMMIT");
    console.log(`[sp] transacao estadual: ${linhas.length} linhas de empresa carregadas`);
    return linhas.length;
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { cli.release(); }
}

/** No boot: carrega uma vez, se a tabela estiver vazia. */
export async function garantirTransacaoSp() {
  const { rows } = await pool.query(`SELECT 1 FROM fisco.estadual_transacao_sp LIMIT 1`).catch(() => ({ rows: [1] }));
  if (rows.length) return;
  await carregarTransacaoSp().catch((e) => console.error("[sp] transacao estadual falhou:", e instanceof Error ? e.message : e));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await carregarTransacaoSp();
  await pool.end();
}
