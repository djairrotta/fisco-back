/**
 * Divida ativa estadual de SP e MG — consulta POR CNPJ, com cache.
 *
 * POR QUE NAO E CARGA EM MASSA, como a federal: nao existe download.
 * Conferido na fonte: a PGE-SP publica planilha agregada de estoque
 * (inscricoes, recuperacoes, baixas), nao lista de devedor. Em MG a
 * Resolucao Conjunta SEF/AGE 5.625/2022 manda publicar a lista de
 * devedores, mas sem formato de download definido. Nos dois casos o
 * acesso util e consulta individual, que a Infosimples expoe.
 *
 * Consequencia de produto: estadual NAO entra no mapa agregado. Entra na
 * ficha da empresa, sob demanda, e fica em cache porque cada consulta
 * custa dinheiro e o dado muda devagar.
 */
import { env } from "../lib/env.js";
import { q, pool } from "../db/pool.js";
import { consultarPgeSp, pgeSpConfigurada } from "./pge-sp.js";

export type UfEstadual = "SP" | "MG";

const CONSULTA: Record<UfEstadual, string> = {
  SP: "pge-sp/divida-ativa",
  MG: "sefaz-mg/divida-ativa",
};

/** Dado estadual muda devagar; 30 dias evita refazer consulta paga à toa. */
const VALIDADE_DIAS = 30;

export interface DividaEstadual {
  uf: UfEstadual;
  tem_debito: boolean | null;
  valor_total: number | null;
  quantidade: number | null;
  consultado_em: string;
  cache: boolean;
  indisponivel?: string;
}

export async function consultarDividaEstadual(
  cnpj: string, uf: UfEstadual, forcar = false
): Promise<DividaEstadual> {
  // CNPJ alfanumerico (julho/2026) tem letra: so a pontuacao sai.
  const limpo = (cnpj || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!/^[0-9A-Z]{12}\d{2}$/.test(limpo)) throw new Error("CNPJ inválido");

  if (!forcar) {
    const [c] = await q<any>(
      `SELECT * FROM divida_estadual
        WHERE cnpj = $1 AND uf = $2 AND consultado_em > now() - ($3 || ' days')::interval`,
      [limpo, uf, String(VALIDADE_DIAS)]
    );
    if (c) return {
      uf, tem_debito: c.tem_debito, valor_total: c.valor_total === null ? null : Number(c.valor_total),
      quantidade: c.quantidade, consultado_em: c.consultado_em, cache: true,
      ...(c.erro ? { indisponivel: c.erro } : {}),
    };
  }

  // SP: API oficial da PGE-SP quando o escritorio tiver a assinatura.
  if (uf === "SP" && pgeSpConfigurada()) {
    try {
      const r = await consultarPgeSp(limpo);
      await pool.query(
        `INSERT INTO divida_estadual (cnpj, uf, tem_debito, valor_total, quantidade, detalhe, fonte, consultado_em, erro)
         VALUES ($1,'SP',$2,$3,$4,$5,'pge-sp-api', now(), NULL)
         ON CONFLICT (cnpj, uf) DO UPDATE SET tem_debito = EXCLUDED.tem_debito, valor_total = EXCLUDED.valor_total,
           quantidade = EXCLUDED.quantidade, detalhe = EXCLUDED.detalhe, fonte = EXCLUDED.fonte, consultado_em = now(), erro = NULL`,
        [limpo, r.tem_debito, r.valor_total, r.quantidade, JSON.stringify(r.detalhe)]);
      return { uf, tem_debito: r.tem_debito, valor_total: r.valor_total, quantidade: r.quantidade, consultado_em: new Date().toISOString(), cache: false };
    } catch (e) {
      if (!env.INFOSIMPLES_TOKEN) {
        return { uf, tem_debito: null, valor_total: null, quantidade: null, consultado_em: new Date().toISOString(), cache: false,
                 indisponivel: `API da PGE-SP: ${String(e instanceof Error ? e.message : e).slice(0, 160)}` };
      }
      // cai para a Infosimples
    }
  }

  if (!env.INFOSIMPLES_TOKEN) {
    return { uf, tem_debito: null, valor_total: null, quantidade: null,
             consultado_em: new Date().toISOString(), cache: false,
             indisponivel: "Consulta estadual não configurada." };
  }

  let tem: boolean | null = null, valor: number | null = null,
      qtd: number | null = null, detalhe: unknown = null, erro: string | null = null;

  try {
    const r = await fetch(`${env.INFOSIMPLES_BASE_URL}/${CONSULTA[uf]}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: env.INFOSIMPLES_TOKEN, cnpj: limpo, timeout: 300 }),
    });
    const d: any = await r.json().catch(() => ({}));
    // A Infosimples devolve 200 com `code` proprio; 200 HTTP nao basta.
    if (d?.code !== 200) {
      erro = String(d?.code_message ?? `resposta ${r.status}`).slice(0, 200);
    } else {
      const itens: any[] = Array.isArray(d.data) ? d.data : [];
      detalhe = itens;
      qtd = itens.length;
      valor = itens.reduce((s, x) => s + (Number(
        String(x?.valor_total ?? x?.valor ?? 0).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".")
      ) || 0), 0);
      tem = qtd > 0 && (valor ?? 0) > 0;
    }
  } catch (e) {
    erro = String(e instanceof Error ? e.message : e).slice(0, 200);
  }

  await pool.query(
    `INSERT INTO divida_estadual (cnpj, uf, tem_debito, valor_total, quantidade,
                                  detalhe, fonte, consultado_em, erro)
     VALUES ($1,$2,$3,$4,$5,$6,'infosimples', now(), $7)
     ON CONFLICT (cnpj, uf) DO UPDATE SET
       tem_debito = EXCLUDED.tem_debito, valor_total = EXCLUDED.valor_total,
       quantidade = EXCLUDED.quantidade, detalhe = EXCLUDED.detalhe,
       consultado_em = now(), erro = EXCLUDED.erro`,
    [limpo, uf, tem, valor, qtd, detalhe ? JSON.stringify(detalhe) : null, erro]
  );

  return { uf, tem_debito: tem, valor_total: valor, quantidade: qtd,
           consultado_em: new Date().toISOString(), cache: false,
           ...(erro ? { indisponivel: erro } : {}) };
}

export const consultaEstadualConfigurada = () => !!env.INFOSIMPLES_TOKEN || pgeSpConfigurada();

/**
 * Varias empresas de uma vez (leads, selecao da pesquisa). Duas consultas
 * em paralelo: a Infosimples cobra por consulta e limita rajada; o cache de
 * 30 dias evita pagar de novo pelo que ja foi consultado.
 */
export async function consultarLoteEstadual(alvos: { cnpj: string; uf: UfEstadual }[]) {
  const fila = [...alvos];
  const res: { cnpj: string; uf: UfEstadual; r?: DividaEstadual; erro?: string }[] = [];
  const trabalhador = async () => {
    for (let a = fila.shift(); a; a = fila.shift()) {
      try { res.push({ ...a, r: await consultarDividaEstadual(a.cnpj, a.uf) }); }
      catch (e) { res.push({ ...a, erro: e instanceof Error ? e.message : String(e) }); }
    }
  };
  await Promise.all([trabalhador(), trabalhador()]);
  return res;
}
