import { lerCabecalho, transformarLinha } from "../src/etl/pgfn.ts";
const cab = lerCabecalho("CPF_CNPJ;TIPO_PESSOA;TIPO_DEVEDOR;NOME_DEVEDOR;UF_DEVEDOR;UNIDADE_RESPONSAVEL;NUMERO_INSCRICAO;TIPO_SITUACAO_INSCRICAO;SITUACAO_INSCRICAO;RECEITA_PRINCIPAL;DATA_INSCRICAO;INDICADOR_AJUIZADO;VALOR_CONSOLIDADO");
const l = "12.345.678/0001-95;Pessoa jurídica;PRINCIPAL;FULANO DE TAL LTDA;SP;PSFN SAO PAULO;80 1 23 012345-67;Em cobrança;Ativa em cobrança;IRPJ - LUCRO PRESUMIDO;01/02/2020;SIM;1234.56";
let t = Date.now(), n = 0;
for (let i = 0; i < 500000; i++) if (transformarLinha(l, cab as any, "PGFN_GERAL" as any, "2026-06-30")) n++;
console.log("transformar:", Math.round(500000 / ((Date.now() - t) / 1000)), "linhas/s");
process.exit(0);
