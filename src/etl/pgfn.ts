/**
 * ETL da divida ativa da PGFN — baixa, transforma e carrega sozinho.
 *
 * Fonte: dadosabertos.pgfn.gov.br/{ANO}_trimestre_{TT}/{base}.zip
 * Tres bases por trimestre, cada zip com varios CSV ';' em LATIN1.
 *
 * O CSV REAL nao corresponde ao schema da tabela: CPF_CNPJ vem com
 * pontuacao, TIPO_DEVEDOR e texto ("Principal"), DATA_INSCRICAO e
 * dd/mm/aaaa e nao existe cnpj_raiz.
 *
 * E AS BASES NAO TEM O MESMO CABECALHO. FGTS e Nao Previdenciario tem 15
 * colunas (com ENTIDADE_RESPONSAVEL, UNIDADE_INSCRICAO e
 * RECEITA_PRINCIPAL); Previdenciario tem 13 e chama o tributo de
 * TIPO_CREDITO. Ler por POSICAO rejeitava 100% do Previdenciario --
 * 3,6 milhoes de linhas. Por isso o parse e feito pelo CABECALHO de cada
 * arquivo, e uma coluna nova na origem deixa de quebrar a carga.
 *
 * PESSOA FISICA ENTRA. Antes era descartada (17,2 milhoes de linhas so
 * no Nao Previdenciario). Ela nao participa dos agregados de EMPRESA:
 * mv_divida_empresa filtra tipo_pessoa='PJ' e PF tem mv_divida_pessoa
 * propria. Somar as duas transformaria CPF em "empresa com divida" no
 * mapa, e o numero que o advogado usa para escolher onde prospectar
 * ficaria falso.
 *
 * DUAS ARMADILHAS QUE CUSTAM CARO:
 *  1. Somar corresponsavel duplica o valor. A propria PGFN avisa: para
 *     valor total, considerar SO o devedor principal (tipo_devedor = 1).
 *  2. A base nao traz municipio, so UF e unidade de inscricao. O "por
 *     cidade" so existe apos o join com a base CNPJ pela raiz.
 */
import { createWriteStream, createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import copy from "pg-copy-streams";
import { pool } from "../db/pool.js";

export const BASES = {
  PGFN_GERAL: "Dados_abertos_Nao_Previdenciario.zip",
  PGFN_PREV: "Dados_abertos_Previdenciario.zip",
  PGFN_FGTS: "Dados_abertos_FGTS.zip",
} as const;
export type Origem = keyof typeof BASES;

const RAIZ = "https://dadosabertos.pgfn.gov.br";

/**
 * O tributo depende da BASE antes da receita. Na Previdenciaria a coluna
 * TIPO_CREDITO traz "OUTROS", "AFERICAO INDIRETA", "SOLIDARIEDADE"... --
 * o tipo do lancamento, nao o tributo. Normalizar so pela receita jogava
 * 3,6 milhoes de inscricoes previdenciarias em "Outros", e o filtro por
 * contribuicao previdenciaria (a tese mais trabalhada) nao achava nada.
 */
export function tributoDaLinha(origem: string, receita: string): string {
  if (origem === "PGFN_PREV") return "Contribuição Previdenciária";
  if (origem === "PGFN_FGTS") return "FGTS";
  return normalizarTributo(receita || origem);
}

export function normalizarTributo(receita: string): string {
  const r = (receita || "").toUpperCase();
  if (r.includes("COFINS")) return "COFINS";
  if (r.includes("PIS")) return "PIS";
  if (r.includes("IRPJ")) return "IRPJ";
  if (r.includes("CSLL")) return "CSLL";
  if (r.includes("SIMPLES")) return "Simples Nacional";
  if (r.includes("FGTS")) return "FGTS";
  if (r.includes("PREVID") || r.includes("INSS") || r.includes("SEGURIDADE"))
    return "Contribuição Previdenciária";
  if (r.includes("IPI")) return "IPI";
  if (r.includes("IOF")) return "IOF";
  if (r.includes("ITR")) return "ITR";
  return "Outros";
}

/**
 * dd/mm/aaaa -> aaaa-mm-dd. Vazio vira null.
 * A PGFN usa 01/01/1000 como "nao informado"; qualquer ano antes de 1900
 * e sentinela, nao data, e vira null em vez de sujar o indice BRIN.
 */
function dataIso(d: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((d || "").trim());
  if (!m) return "";
  if (Number(m[3]) < 1900) return "";
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Mapa coluna -> indice, a partir do cabecalho do proprio arquivo. */
export type Mapa = Record<string, number>;
export function lerCabecalho(linha: string): Mapa {
  const m: Mapa = {};
  linha.replace(/^\uFEFF/, "").split(";").forEach((c, i) => {
    m[c.trim().toUpperCase()] = i;
  });
  return m;
}

function csvCampo(v: string): string {
  if (v === "") return "";
  return /[";\n,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Rejeicao com MOTIVO. Um numero solto de rejeitadas e inutil: no 2o tri/2026
 * o Nao Previdenciario rejeitou 38% das linhas, e sem discriminar o motivo
 * nao da para saber se sao pessoas fisicas (correto, elas nao sao mercado
 * deste produto) ou erro de parse (perda de um terco do mercado). Os dois
 * casos tem exatamente a mesma aparencia num contador unico.
 */
export interface Contagem {
  lidas: number;
  aceitas: number;
  rejeitadas: number;
  motivos: Record<string, number>;
}
export const novaContagem = (): Contagem =>
  ({ lidas: 0, aceitas: 0, rejeitadas: 0, motivos: {} });

export type Motivo =
  | "colunas_faltando" | "documento_invalido" | "valor_invalido"
  | "tipo_pessoa_desconhecido";

/**
 * Converte uma linha do CSV da PGFN na linha da tabela.
 * Devolve null quando a linha nao serve (pessoa fisica, CNPJ invalido,
 * numero de colunas errado, valor nao numerico).
 */
export function transformarLinha(
  linha: string, mapa: Mapa, origem: Origem, dataRef: string,
  anotar?: (m: Motivo) => void
): string | null {
  const p = linha.split(";");
  const v = (nome: string) => {
    const i = mapa[nome];
    return i === undefined ? "" : (p[i] ?? "").trim();
  };
  // Cabecalho conhecido: se faltar coluna essencial, a linha nao serve.
  if (p.length < Object.keys(mapa).length) { anotar?.("colunas_faltando"); return null; }

  // PJ e PF entram. O rotulo da origem decide; quando ele nao e nenhum
  // dos dois conhecidos, o TAMANHO DO DOCUMENTO decide, e so entao a
  // linha e recusada. Confiar cegamente no rotulo faria uma categoria
  // nova da PGFN ("Pessoa juridica de direito publico", um campo vazio)
  // sumir em silencio -- que foi exatamente como 17 milhoes de CPF
  // desapareciam antes.
  // A PGFN publica o CNPJ inteiro e o CPF MASCARADO (XXX878.325XX): so
  // os 6 digitos do meio. Por isso nao da para normalizar os dois do
  // mesmo jeito -- tirar os nao-digitos de um CPF mascarado devolve 6
  // digitos, que nao e CPF nenhum.
  // CNPJ ALFANUMERICO (Receita, a partir de julho/2026): os 12 primeiros
  // caracteres podem ser letras A-Z; so os 2 verificadores sao digitos.
  // Tirar "nao-digitos" apagaria as letras e mataria esses CNPJs. E a
  // letra X, que a PGFN usa na mascara do CPF, tambem e letra valida de
  // CNPJ: por isso a mascara so vale para PF.
  const bruto = v("CPF_CNPJ").trim();
  const digitos = bruto.replace(/\D/g, "");
  const alnum = bruto.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const pareceCnpj = /^[0-9A-Z]{12}[0-9]{2}$/.test(alnum) && !bruto.includes("*")
    && !/^X{3}/i.test(alnum);
  const rotulo = v("TIPO_PESSOA");
  let tipoPessoa: "PJ" | "PF";
  if (/jur/i.test(rotulo)) tipoPessoa = "PJ";
  else if (/f[ií]s/i.test(rotulo)) tipoPessoa = "PF";
  else if (pareceCnpj) {
    tipoPessoa = "PJ"; anotar?.("tipo_pessoa_desconhecido");
  } else if (/[X*]/i.test(bruto) || digitos.length === 11) {
    tipoPessoa = "PF"; anotar?.("tipo_pessoa_desconhecido");
  } else { anotar?.("tipo_pessoa_desconhecido"); return null; }

  // PJ precisa dos 14 digitos. PF guarda o valor PUBLICADO, mascara e
  // tudo: 'XXX878.325XX' ninguem confunde com CPF, '878325' alguem usaria
  // como chave e erraria.
  const mascarado = tipoPessoa === "PF" && /[X*]/i.test(bruto);
  const doc = tipoPessoa === "PJ" ? alnum : bruto;
  if (tipoPessoa === "PJ" && !/^[0-9A-Z]{12}[0-9]{2}$/.test(doc)) {
    anotar?.("documento_invalido"); return null;
  }
  if (tipoPessoa === "PF" && !doc) { anotar?.("documento_invalido"); return null; }

  const valorTexto = v("VALOR_CONSOLIDADO").replace(/\s/g, "").replace(",", ".");
  const valor = Number(valorTexto);
  if (!Number.isFinite(valor)) { anotar?.("valor_invalido"); return null; }

  // O tributo muda de nome conforme a base: RECEITA_PRINCIPAL (FGTS e
  // Nao Previdenciario) ou TIPO_CREDITO (Previdenciario).
  const receita = v("RECEITA_PRINCIPAL") || v("TIPO_CREDITO");
  const unidade = v("UNIDADE_INSCRICAO") || v("UNIDADE_RESPONSAVEL");

  const campos = [
    doc,
    mascarado ? "false" : "true",
    tipoPessoa === "PJ" ? doc.slice(0, 8) : "",   // CPF nao tem raiz
    v("UF_DEVEDOR").toUpperCase().slice(0, 2),
    origem,
    v("NUMERO_INSCRICAO"),
    // Tres valores na origem, nao dois: PRINCIPAL, CORRESPONSAVEL e
    // SOLIDARIO. Achatar solidario em corresponsavel apaga uma distincao
    // juridica real para quem vai montar a defesa.
    (() => {
      const t = v("TIPO_DEVEDOR");
      if (/principal/i.test(t)) return "1";
      if (/solid/i.test(t)) return "3";
      return "2";
    })(),
    v("TIPO_SITUACAO_INSCRICAO"),
    v("SITUACAO_INSCRICAO"),
    receita,
    tributoDaLinha(origem, receita),
    String(valor),
    dataIso(v("DATA_INSCRICAO")),
    unidade,
    dataRef,
    v("NOME_DEVEDOR"),
    tipoPessoa,
    /^sim$/i.test(v("INDICADOR_AJUIZADO")) ? "true" : "false",
    unidade,
  ];
  return campos.map(csvCampo).join(";") + "\n";
}

const COLUNAS = `documento, documento_completo, cnpj_raiz, uf, origem, numero_inscricao, tipo_devedor,
                 tipo_situacao, situacao, receita_principal, tributo,
                 valor_consolidado, data_inscricao, unidade_origem, data_referencia,
                 nome_devedor, tipo_pessoa, ajuizado, unidade_inscricao`;

/** Lê um CSV do zip, transforma e despeja no COPY aberto. */
async function enviarCsv(entrada: NodeJS.ReadableStream, destino: Writable,
                         origem: Origem, dataRef: string, c: Contagem) {
  const rl = createInterface({ input: entrada as Readable, crlfDelay: Infinity });
  const lote: string[] = [];
  let mapa: Mapa | null = null;
  for await (const bruta of rl) {
    if (!mapa) { mapa = lerCabecalho(bruta); continue; }   // cabecalho do arquivo
    if (!bruta.trim()) continue;
    c.lidas++;
    const linha = transformarLinha(bruta, mapa, origem, dataRef,
      (m) => { c.motivos[m] = (c.motivos[m] ?? 0) + 1; });
    if (!linha) { c.rejeitadas++; continue; }
    c.aceitas++;
    // Escreve em blocos de ~5 mil linhas, nao linha a linha. Uma escrita
    // por linha virava uma mensagem por linha no socket do Postgres: a
    // carga andava a ~6 mil linhas/s com o processo a 100% de CPU, e a
    // base nao previdenciaria (45 milhoes de linhas) levava horas.
    lote.push(linha);
    if (lote.length >= 5000) await despejar(destino, lote);
  }
  await despejar(destino, lote);
}

async function despejar(destino: Writable, buf: string[]) {
  if (!buf.length) return;
  const bloco = buf.join("");
  buf.length = 0;
  if (!destino.write(bloco)) {
    await new Promise<void>((r) => destino.once("drain", () => r()));
  }
}

/** Baixa o zip do trimestre para um arquivo temporario. */
async function baixar(url: string, destino: string): Promise<number> {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`download falhou: ${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body as any), createWriteStream(destino));
  return (await stat(destino)).size;
}

/**
 * Carrega uma base de um trimestre.
 * periodo: "2026_trimestre_02". dataRef: data de referencia da posicao.
 */
export async function carregarBase(origem: Origem, periodo: string, dataRef: string) {
  const dir = await mkdtemp(join(tmpdir(), "pgfn-"));
  const zipLocal = join(dir, BASES[origem]);
  const c = novaContagem();
  let arquivos = 0;

  const cli = await pool.connect();
  try {
    await cli.query(
      `INSERT INTO fisco.carga_etl (origem, periodo) VALUES ($1,$2)
       ON CONFLICT (origem, periodo) DO UPDATE
         SET comecou_em = now(), terminou_em = NULL, erro = NULL`,
      [origem, periodo]
    );

    const bytes = await baixar(`${RAIZ}/${periodo}/${BASES[origem]}`, zipLocal);
    console.log(`[pgfn] ${origem} ${periodo}: ${(bytes / 1e6).toFixed(1)} MB baixados`);

    // Os SET vem ANTES do COPY, nunca depois. Com o COPY FROM STDIN aberto,
    // qualquer outra query nesta conexao entra na fila atras dele; o COPY
    // espera dados que so viriam depois do await dessa query, e as duas
    // pontas ficam esperando uma a outra para sempre. Foi exatamente o que
    // aconteceu: a carga travava sem erro, a 0% de CPU, segurando a
    // transacao aberta.
    // SET LOCAL, dentro da transacao: vale so para esta carga e some no
    // COMMIT/ROLLBACK. SET simples voltaria ao pool com a conexao e
    // contaminaria a proxima consulta da API (o mesmo tipo de vazamento que
    // ja derrubou a producao, no sentido inverso).
    // Uma carga de 1,4 GB nao cabe em limite de minutos.
    await cli.query("BEGIN");
    await cli.query("SET LOCAL statement_timeout = 0");
    await cli.query("SET LOCAL lock_timeout = '5min'");
    await cli.query(`CREATE TEMP TABLE stage_divida
                     (LIKE fisco.divida_inscricao INCLUDING DEFAULTS) ON COMMIT DROP`);
    const destino = cli.query(copy.from(
      `COPY stage_divida (${COLUNAS})
       FROM STDIN WITH (FORMAT csv, DELIMITER ';', NULL '')`
    ) as unknown as never) as unknown as Writable;

    // O handler de 'error' TEM que existir antes do primeiro write. Se o
    // COPY falhar no meio da escrita e ninguem estiver escutando, o Node
    // trata como 'error' nao tratado e DERRUBA O PROCESSO -- o container
    // reinicia, o agendador roda de novo e vira laco de crash, com a API
    // fora do ar junto. Ja aconteceu em producao.
    let erroCopy: Error | null = null;
    destino.on("error", (e: Error) => { erroCopy = e; });

    const zip = await unzipper.Open.file(zipLocal);
    for (const e of zip.files) {
      if (e.type !== "File" || !e.path.toLowerCase().endsWith(".csv")) continue;
      arquivos++;
      await enviarCsv(e.stream().setEncoding("latin1"), destino, origem, dataRef, c);
    }
    if (erroCopy) throw erroCopy;
    destino.end();
    await new Promise<void>((ok, erro) => {
      if (erroCopy) return erro(erroCopy);
      destino.on("finish", () => ok());
      destino.on("error", erro);
    });
    if (erroCopy) throw erroCopy;

    // Substitui a posicao anterior daquela origem; nao acumula trimestres.
    await cli.query(`DELETE FROM fisco.divida_inscricao WHERE origem = $1`, [origem]);
    await cli.query(`INSERT INTO fisco.divida_inscricao (${COLUNAS})
                     SELECT ${COLUNAS} FROM stage_divida`);
    await cli.query("COMMIT");

    await cli.query(
      `UPDATE fisco.carga_etl SET terminou_em = now(), arquivos = $3,
              linhas_lidas = $4, linhas_aceitas = $5, linhas_rejeitadas = $6,
              motivos_rejeicao = $7
        WHERE origem = $1 AND periodo = $2`,
      [origem, periodo, arquivos, c.lidas, c.aceitas, c.rejeitadas,
       JSON.stringify(c.motivos)]
    );
    const detalhe = Object.entries(c.motivos)
      .sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}=${n}`).join(" ");
    console.log(`[pgfn] ${origem}: ${arquivos} arquivos, ${c.lidas} lidas, ` +
                `${c.aceitas} aceitas, ${c.rejeitadas} rejeitadas` +
                (detalhe ? ` (${detalhe})` : ""));
    return c;
  } catch (e) {
    await cli.query("ROLLBACK").catch(() => {});
    await cli.query(
      `UPDATE fisco.carga_etl SET terminou_em = now(), erro = $3
        WHERE origem = $1 AND periodo = $2`,
      [origem, periodo, String(e instanceof Error ? e.message : e).slice(0, 500)]
    ).catch(() => {});
    throw e;
  } finally {
    cli.release();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , periodo, dataRef, ...quais] = process.argv;
  if (!periodo || !dataRef) {
    console.log("uso: node dist/etl/pgfn.js <2026_trimestre_02> <2026-06-30> [PGFN_FGTS ...]");
    process.exit(1);
  }
  const alvos = (quais.length ? quais : Object.keys(BASES)) as Origem[];
  for (const o of alvos) await carregarBase(o, periodo, dataRef);
  await pool.end();
}
