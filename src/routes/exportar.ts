/**
 * Exportacao da pesquisa de empresas: CSV ou planilha (XLSX), ate 100 mil
 * linhas, com as colunas que o usuario escolher. Le por cursor do banco
 * (5 mil por vez) e escreve direto na resposta: 100 mil linhas nao passam
 * inteiras pela memoria.
 */
import type { FastifyInstance } from "fastify";
import { PassThrough } from "node:stream";
import ExcelJS from "exceljs";
import { pool, q } from "../db/pool.js";
import { lista, numero, sessao } from "../lib/http.js";
import { montarBusca, type FiltrosBusca } from "./busca.js";

const SIT: Record<number, string> = { 1: "Nula", 2: "Ativa", 3: "Suspensa", 4: "Inapta", 8: "Baixada" };
const PORTE: Record<number, string> = { 1: "ME", 3: "EPP", 5: "Demais" };

/** Catalogo de colunas: rotulo, expressao SQL, grupo (para a tela). */
export const COLUNAS: Record<string, { rotulo: string; sql: string; grupo: string; padrao?: boolean; largura?: number }> = {
  cnpj: { rotulo: "CNPJ", sql: "e.cnpj", grupo: "Cadastro", padrao: true, largura: 18 },
  razao_social: { rotulo: "Razão social", sql: "e.razao_social", grupo: "Cadastro", padrao: true, largura: 40 },
  nome_fantasia: { rotulo: "Nome fantasia", sql: "e.nome_fantasia", grupo: "Cadastro", padrao: true, largura: 28 },
  situacao: { rotulo: "Situação", sql: "e.situacao", grupo: "Cadastro", padrao: true },
  data_situacao: { rotulo: "Data da situação", sql: "e.data_situacao", grupo: "Cadastro" },
  matriz: { rotulo: "Matriz/filial", sql: "CASE WHEN e.matriz THEN 'Matriz' ELSE 'Filial' END", grupo: "Cadastro" },
  data_abertura: { rotulo: "Abertura", sql: "e.data_abertura", grupo: "Cadastro", padrao: true },
  cnae_principal: { rotulo: "CNAE principal", sql: "e.cnae_principal", grupo: "Atividade", padrao: true },
  cnae_descricao: { rotulo: "Atividade principal", sql: "(SELECT descricao FROM cnae_ref c WHERE c.codigo = e.cnae_principal)", grupo: "Atividade", padrao: true, largura: 40 },
  cnae_secundarios: { rotulo: "CNAEs secundários", sql: "array_to_string(e.cnae_secundarios, ', ')", grupo: "Atividade", largura: 30 },
  natureza: { rotulo: "Natureza jurídica", sql: "(SELECT descricao FROM natureza_ref n WHERE n.codigo = e.natureza_juridica)", grupo: "Perfil", largura: 30 },
  porte: { rotulo: "Porte", sql: "e.porte", grupo: "Perfil", padrao: true },
  regime: { rotulo: "Regime", sql: "CASE WHEN e.opcao_mei THEN 'MEI' WHEN e.opcao_simples THEN 'Simples' ELSE 'Fora do Simples' END", grupo: "Perfil", padrao: true },
  data_exclusao_simples: { rotulo: "Exclusão do Simples", sql: "e.data_exclusao_simples", grupo: "Perfil" },
  data_exclusao_mei: { rotulo: "Saída do MEI", sql: "e.data_exclusao_mei", grupo: "Perfil" },
  capital_social: { rotulo: "Capital social", sql: "e.capital_social", grupo: "Perfil", padrao: true },
  logradouro: { rotulo: "Endereço", sql: "concat_ws(', ', e.logradouro, e.numero, e.complemento)", grupo: "Endereço", padrao: true, largura: 40 },
  bairro: { rotulo: "Bairro", sql: "e.bairro", grupo: "Endereço", padrao: true },
  cep: { rotulo: "CEP", sql: "e.cep", grupo: "Endereço", padrao: true },
  municipio: { rotulo: "Município", sql: "e.municipio", grupo: "Endereço", padrao: true },
  uf: { rotulo: "UF", sql: "e.uf", grupo: "Endereço", padrao: true },
  telefone: { rotulo: "Telefone", sql: "e.telefone", grupo: "Contato", padrao: true },
  telefone2: { rotulo: "Telefone 2", sql: "e.telefone2", grupo: "Contato", padrao: true },
  email: { rotulo: "E-mail", sql: "e.email", grupo: "Contato", padrao: true, largura: 30 },
  contador: { rotulo: "Contato é do contador?", sql: "CASE WHEN coalesce(e.email_contador, false) OR coalesce(e.telefone_contador, false) THEN 'provável' END", grupo: "Contato" },
  socios: { rotulo: "Sócios", sql: "(SELECT string_agg(nome, '; ' ORDER BY entrada NULLS LAST) FROM socio s WHERE s.cnpj_raiz = e.cnpj_raiz)", grupo: "Sócios", padrao: true, largura: 40 },
  qtd_socios: { rotulo: "Nº de sócios", sql: "(SELECT count(*) FROM socio s WHERE s.cnpj_raiz = e.cnpj_raiz)", grupo: "Sócios" },
  divida_total: { rotulo: "Dívida federal", sql: "d.valor_total", grupo: "Dívida", padrao: true },
  divida_ajuizada: { rotulo: "Dívida ajuizada", sql: "d.valor_ajuizado", grupo: "Dívida" },
  inscricoes: { rotulo: "Inscrições", sql: "d.qtd_inscricoes", grupo: "Dívida" },
  tributo: { rotulo: "Tributo principal", sql: "d.tributo_principal", grupo: "Dívida" },
  acordo: { rotulo: "Acordo", sql: "CASE WHEN d.qtd_rescindidas > 0 THEN 'rescindido' WHEN d.qtd_negociadas > 0 THEN 'em acordo' WHEN d.cnpj_raiz IS NOT NULL THEN 'sem acordo' END", grupo: "Dívida" },
  regime_tributario: { rotulo: "Regime tributário (ECF)", sql: "(SELECT CASE m.tipo WHEN 'real' THEN 'Lucro Real' WHEN 'presumido' THEN 'Lucro Presumido' WHEN 'arbitrado' THEN 'Lucro Arbitrado' ELSE 'Imune/isenta' END || ' (' || m.ano || ')' FROM empresa_marca m WHERE m.cnpj_raiz = e.cnpj_raiz AND m.fonte = 'ecf_regime' LIMIT 1)", grupo: "Bases extras" },
  beneficios: { rotulo: "Benefícios fiscais (SISEN)", sql: "(SELECT string_agg(DISTINCT m.tipo, '; ') FROM empresa_marca m WHERE m.cnpj_raiz = e.cnpj_raiz AND m.fonte = 'sisen')", grupo: "Bases extras", largura: 30 },
  incentivos: { rotulo: "Incentivos no IRPJ (PAT, Empresa Cidadã…)", sql: "(SELECT string_agg(DISTINCT m.tipo, ', ') FROM empresa_marca m WHERE m.cnpj_raiz = e.cnpj_raiz AND m.fonte = 'incentivo')", grupo: "Bases extras" },
  parcelamento_saldo: { rotulo: "Saldo em parcelamento na Receita", sql: "(SELECT sum(m.valor) FROM empresa_marca m WHERE m.cnpj_raiz = e.cnpj_raiz AND m.fonte = 'parcelamento')", grupo: "Bases extras" },
  sancoes: { rotulo: "Sanções (CEIS/CNEP)", sql: "(SELECT string_agg(DISTINCT m.tipo, '; ') FROM empresa_marca m WHERE m.cnpj_raiz = e.cnpj_raiz AND m.fonte IN ('ceis','cnep'))", grupo: "Bases extras", largura: 30 },
  inscricao_antiga: { rotulo: "Inscrição mais antiga", sql: "d.inscricao_mais_antiga", grupo: "Dívida" },
};

const TETO = 100_000;

export default async function rotasExportar(app: FastifyInstance) {
  const auth = { onRequest: [(app as any).authenticate] };

  app.get("/api/busca/colunas", auth, async () =>
    Object.entries(COLUNAS).map(([id, c]) => ({ id, rotulo: c.rotulo, grupo: c.grupo, padrao: !!c.padrao })));

  app.get<{ Querystring: FiltrosBusca & { formato?: string; colunas?: string; max?: string } }>(
    "/api/busca/exportar", auth, async (req, reply) => {
      const { tenant, sub } = sessao(req);
      const f = req.query;
      const formato = f.formato === "xlsx" ? "xlsx" : "csv";
      const max = numero(f.max, TETO, 1, TETO);
      let cols = lista(f.colunas).filter((c) => COLUNAS[c]);
      if (!cols.length) cols = Object.keys(COLUNAS).filter((c) => COLUNAS[c].padrao);
      const { where, params } = await montarBusca(f, tenant);
      const sql = `SELECT ${cols.map((c) => `${COLUNAS[c].sql} AS "${c}"`).join(", ")}
                     FROM estabelecimento e LEFT JOIN mv_devedor d ON d.cnpj_raiz = e.cnpj_raiz
                     ${where} ORDER BY e.pontos_contato DESC NULLS LAST, e.cnpj LIMIT ${max}`;

      const valor = (c: string, v: any) => {
        if (v == null) return null;
        if (c === "situacao") return SIT[v] ?? v;
        if (c === "porte") return PORTE[v] ?? v;
        if (["capital_social", "divida_total", "divida_ajuizada", "parcelamento_saldo"].includes(c)) return Number(v);
        if (["qtd_socios", "inscricoes"].includes(c)) return Number(v);
        return v;
      };
      if (f.formato === "json") {
        const linhas = await q(sql.replace(/LIMIT \d+$/, `LIMIT ${Math.min(max, 1000)}`), params);
        return { colunas: cols.map((c) => ({ id: c, rotulo: COLUNAS[c].rotulo })), linhas: linhas.map((r) => Object.fromEntries(cols.map((c) => [c, valor(c, r[c])]))) };
      }
      const nome = `empresas-${new Date().toISOString().slice(0, 10)}.${formato}`;
      const saida = new PassThrough();
      reply.header("content-disposition", `attachment; filename="${nome}"`);
      reply.header("content-type", formato === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv; charset=utf-8");

      const cli = await pool.connect();
      const rodar = async () => {
        let n = 0;
        let wb: ExcelJS.stream.xlsx.WorkbookWriter | null = null;
        let ws: ExcelJS.Worksheet | null = null;
        const esc = (v: unknown) => {
          if (v == null) return "";
          const s = typeof v === "number" ? String(v).replace(".", ",") : String(v);
          return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        if (formato === "xlsx") {
          wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: saida, useStyles: true });
          ws = wb.addWorksheet("Empresas", { views: [{ state: "frozen", ySplit: 1 }] });
          ws.columns = cols.map((c) => ({ header: COLUNAS[c].rotulo, key: c, width: COLUNAS[c].largura ?? 16 }));
          ws.getRow(1).font = { bold: true };
          ws.getRow(1).commit();
        } else {
          saida.write("﻿" + cols.map((c) => esc(COLUNAS[c].rotulo)).join(";") + "\r\n");
        }
        try {
          await cli.query("BEGIN");
          await cli.query("SET LOCAL statement_timeout = '10min'");
          await cli.query(`DECLARE exp NO SCROLL CURSOR FOR ${sql}`, params);
          for (;;) {
            const { rows } = await cli.query(`FETCH 5000 FROM exp`);
            if (!rows.length) break;
            for (const r of rows) {
              n++;
              if (ws) {
                const linha = ws.addRow(Object.fromEntries(cols.map((c) => [c, valor(c, r[c])])));
                linha.commit();
              } else {
                const ok = saida.write(cols.map((c) => esc(valor(c, r[c]))).join(";") + "\r\n");
                if (!ok) await new Promise((res) => saida.once("drain", res));
              }
            }
          }
          await cli.query("COMMIT");
        } catch (e) {
          await cli.query("ROLLBACK").catch(() => {});
          throw e;
        } finally { cli.release(); }
        if (wb && ws) { ws.commit(); await wb.commit(); } else saida.end();
        await q(`INSERT INTO busca_exportacao (tenant_id, usuario_id, formato, linhas, colunas, filtros)
                 VALUES ($1, $2, $3, $4, $5, $6)`, [tenant, sub, formato, n, cols, JSON.stringify(f)]).catch(() => {});
      };
      rodar().catch((e) => { req.log.error(e); saida.destroy(e); });
      return reply.send(saida);
    });

  app.get("/api/busca/exportacoes", auth, async (req) => {
    const { tenant } = sessao(req);
    return q(`SELECT x.formato, x.linhas, x.criado_em, u.nome AS usuario FROM busca_exportacao x
                LEFT JOIN usuario u ON u.id = x.usuario_id
               WHERE x.tenant_id = $1 ORDER BY x.criado_em DESC LIMIT 30`, [tenant]);
  });
}
