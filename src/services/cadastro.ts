/**
 * Cadastro de uma empresa por CNPJ, sob demanda.
 *
 * A ordem das fontes:
 *   1. tabela `estabelecimento` (carga mensal da Receita), quando ja rodou
 *   2. cache local de consultas anteriores (30 dias)
 *   3. BrasilAPI (espelho publico do cadastro da Receita)
 *   4. publica.cnpj.ws, se a BrasilAPI falhar
 *
 * E isto que permite o lead ter telefone, e-mail e quadro societario no
 * mesmo dia em que entra, sem esperar a carga mensal de 4 GB.
 *
 * Os contatos vem do CADASTRO NA RECEITA: o que a empresa declarou, que
 * muitas vezes e o telefone ou o e-mail do CONTADOR que fez o registro.
 * A heuristica `provavel_contador` marca esses casos para o advogado nao
 * ligar para o escritorio de contabilidade achando que e o cliente.
 */
import { q } from "../db/pool.js";

export interface Socio {
  nome: string;
  qualificacao: string | null;
  documento: string | null;     // mascarado pela propria Receita
  entrada: string | null;
  faixa_etaria: string | null;
  tipo: "PF" | "PJ" | "EX";
}

export interface Contato {
  tipo: "telefone" | "email";
  valor: string;
  provavel_contador: boolean;
}

export interface Cadastro {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  situacao: string | null;
  data_situacao: string | null;
  data_abertura: string | null;
  natureza_juridica: string | null;
  porte: string | null;
  capital_social: number | null;
  cnae: { codigo: string; descricao: string | null } | null;
  cnaes_secundarios: { codigo: string; descricao: string | null }[];
  simples: boolean | null;
  mei: boolean | null;
  endereco: {
    logradouro: string | null; numero: string | null; complemento: string | null;
    bairro: string | null; cep: string | null; municipio: string | null;
    municipio_ibge: string | null; uf: string | null;
  };
  contatos: Contato[];
  socios: Socio[];
  fonte: "receita_carga" | "brasilapi" | "cnpjws";
  consultado_em: string;
}

const VALIDADE_DIAS = 30;
const RX_CONTADOR = /cont[aá]b|contador|escrit[oó]rio|assessoria|cont\.|consultoria\s*cont/i;

export function provavelContador(v: string): boolean {
  return RX_CONTADOR.test(v);
}

const fone = (s: string | null | undefined): string | null => {
  const d = (s || "").replace(/\D/g, "");
  return d.length >= 10 && !/^(\d)\1+$/.test(d) ? d : null;
};

function contatos(fones: (string | null | undefined)[], email: string | null | undefined): Contato[] {
  const r: Contato[] = [];
  const vistos = new Set<string>();
  for (const f of fones) {
    const n = fone(f);
    if (n && !vistos.has(n)) { vistos.add(n); r.push({ tipo: "telefone", valor: n, provavel_contador: false }); }
  }
  const e = (email || "").trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e)) {
    r.push({ tipo: "email", valor: e, provavel_contador: provavelContador(e) });
  }
  return r;
}

const PORTE: Record<string, string> = { "1": "Microempresa", "3": "Empresa de pequeno porte", "5": "Demais" };
const SITUACAO: Record<string, string> = { "1": "Nula", "2": "Ativa", "3": "Suspensa", "4": "Inapta", "8": "Baixada" };
const FAIXA: Record<string, string> = {
  "1": "0 a 12 anos", "2": "13 a 20 anos", "3": "21 a 30 anos", "4": "31 a 40 anos",
  "5": "41 a 50 anos", "6": "51 a 60 anos", "7": "61 a 70 anos", "8": "71 a 80 anos", "9": "mais de 80 anos",
};

/** Normaliza a resposta da BrasilAPI. Exportado para teste. */
export function deBrasilApi(j: any): Cadastro {
  return {
    cnpj: String(j.cnpj),
    razao_social: j.razao_social || null,
    nome_fantasia: j.nome_fantasia || null,
    situacao: j.descricao_situacao_cadastral || null,
    data_situacao: j.data_situacao_cadastral || null,
    data_abertura: j.data_inicio_atividade || null,
    natureza_juridica: j.natureza_juridica || null,
    porte: j.porte || null,
    capital_social: j.capital_social == null ? null : Number(j.capital_social),
    cnae: j.cnae_fiscal ? { codigo: String(j.cnae_fiscal).padStart(7, "0"), descricao: j.cnae_fiscal_descricao || null } : null,
    cnaes_secundarios: (j.cnaes_secundarios || [])
      .filter((c: any) => c?.codigo)
      .map((c: any) => ({ codigo: String(c.codigo).padStart(7, "0"), descricao: c.descricao || null })),
    simples: j.opcao_pelo_simples ?? null,
    mei: j.opcao_pelo_mei ?? null,
    endereco: {
      logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" ") || null,
      numero: j.numero || null, complemento: j.complemento || null, bairro: j.bairro || null,
      cep: j.cep ? String(j.cep).replace(/\D/g, "") : null, municipio: j.municipio || null,
      municipio_ibge: j.codigo_municipio_ibge ? String(j.codigo_municipio_ibge) : null, uf: j.uf || null,
    },
    contatos: contatos([j.ddd_telefone_1, j.ddd_telefone_2], j.email),
    socios: (j.qsa || []).map((s: any) => ({
      nome: s.nome_socio,
      qualificacao: s.qualificacao_socio || null,
      documento: s.cnpj_cpf_do_socio || null,
      entrada: s.data_entrada_sociedade || null,
      faixa_etaria: s.faixa_etaria || null,
      tipo: s.identificador_de_socio === 1 ? "PJ" : s.identificador_de_socio === 3 ? "EX" : "PF",
    })),
    fonte: "brasilapi",
    consultado_em: new Date().toISOString(),
  };
}

function deCnpjWs(j: any): Cadastro {
  const e = j.estabelecimento || {};
  const tel = (d?: string, n?: string) => (d && n ? `${d}${n}` : null);
  return {
    cnpj: String(e.cnpj),
    razao_social: j.razao_social || null,
    nome_fantasia: e.nome_fantasia || null,
    situacao: e.situacao_cadastral || null,
    data_situacao: e.data_situacao_cadastral || null,
    data_abertura: e.data_inicio_atividade || null,
    natureza_juridica: j.natureza_juridica?.descricao || null,
    porte: j.porte?.descricao || null,
    capital_social: j.capital_social == null ? null : Number(j.capital_social),
    cnae: e.atividade_principal ? { codigo: String(e.atividade_principal.id).padStart(7, "0"), descricao: e.atividade_principal.descricao || null } : null,
    cnaes_secundarios: (e.atividades_secundarias || []).map((c: any) => ({ codigo: String(c.id).padStart(7, "0"), descricao: c.descricao || null })),
    simples: j.simples?.simples === "Sim" ? true : j.simples ? false : null,
    mei: j.simples?.mei === "Sim" ? true : j.simples ? false : null,
    endereco: {
      logradouro: [e.tipo_logradouro, e.logradouro].filter(Boolean).join(" ") || null,
      numero: e.numero || null, complemento: e.complemento || null, bairro: e.bairro || null,
      cep: e.cep || null, municipio: e.cidade?.nome || null,
      municipio_ibge: e.cidade?.ibge_id ? String(e.cidade.ibge_id) : null, uf: e.estado?.sigla || null,
    },
    contatos: contatos([tel(e.ddd1, e.telefone1), tel(e.ddd2, e.telefone2)], e.email),
    socios: (j.socios || []).map((s: any) => ({
      nome: s.nome, qualificacao: s.qualificacao_socio?.descricao || null,
      documento: s.cpf_cnpj_socio || null, entrada: s.data_entrada || null,
      faixa_etaria: s.faixa_etaria || null,
      tipo: s.tipo === "Pessoa Jurídica" ? "PJ" : s.tipo === "Estrangeiro" ? "EX" : "PF",
    })),
    fonte: "cnpjws",
    consultado_em: new Date().toISOString(),
  };
}

async function daCargaReceita(cnpj: string): Promise<Cadastro | null> {
  const [e] = await q<any>(`SELECT * FROM estabelecimento WHERE cnpj = $1 LIMIT 1`, [cnpj]);
  if (!e) return null;
  const socios = await q<any>(
    `SELECT nome, qualificacao, documento, entrada, faixa_etaria, tipo
       FROM socio WHERE cnpj_raiz = $1 ORDER BY entrada NULLS LAST`, [cnpj.slice(0, 8)]);
  return {
    cnpj, razao_social: e.razao_social, nome_fantasia: e.nome_fantasia,
    situacao: SITUACAO[String(e.situacao)] ?? null, data_situacao: e.data_situacao,
    data_abertura: e.data_abertura, natureza_juridica: null,
    porte: PORTE[String(e.porte)] ?? null,
    capital_social: e.capital_social == null ? null : Number(e.capital_social),
    cnae: e.cnae_principal ? { codigo: e.cnae_principal, descricao: null } : null,
    cnaes_secundarios: [], simples: e.opcao_simples, mei: e.opcao_mei,
    endereco: {
      logradouro: e.logradouro, numero: e.numero, complemento: null, bairro: e.bairro,
      cep: e.cep, municipio: e.municipio, municipio_ibge: e.municipio_ibge, uf: e.uf,
    },
    contatos: contatos([e.telefone], e.email),
    socios: socios.map((s) => ({ ...s, faixa_etaria: FAIXA[String(s.faixa_etaria)] ?? null })),
    fonte: "receita_carga",
    consultado_em: e.atualizado_em,
  };
}

async function buscarJson(url: string, ms = 12000): Promise<any | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (r.status === 404) return { __naoExiste: true };
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * Cadastro do CNPJ. `forcar` ignora o cache (botao "atualizar dados").
 * Devolve null quando nenhuma fonte respondeu; a tela diz isso em vez de
 * fingir que a empresa nao tem telefone.
 */
export async function consultarCadastro(cnpj: string, forcar = false): Promise<Cadastro | null> {
  // A carga mensal nao traz QSA completo nem CNAE secundario quando o
  // filtro por devedoras esta ligado; ainda assim e a fonte primaria.
  const carga = await daCargaReceita(cnpj).catch(() => null);

  if (!forcar) {
    const [c] = await q<{ dados: Cadastro; buscado_em: Date }>(
      `SELECT dados, buscado_em FROM empresa_cache
        WHERE cnpj = $1 AND buscado_em > now() - ($2 || ' days')::interval`,
      [cnpj, String(VALIDADE_DIAS)]);
    if (c) return mesclar(carga, c.dados);
  }

  let dados: Cadastro | null = null;
  // CNPJ alfanumerico: as APIs publicas aceitam? A BrasilAPI ainda nao
  // documenta. Se responder 404, cai na carga mensal sem erro.
  const j = await buscarJson(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
  if (j && !j.__naoExiste && j.cnpj) dados = deBrasilApi(j);
  if (!dados) {
    const k = await buscarJson(`https://publica.cnpj.ws/cnpj/${cnpj}`);
    if (k && !k.__naoExiste && k.estabelecimento) dados = deCnpjWs(k);
  }
  if (dados) {
    await q(
      `INSERT INTO empresa_cache (cnpj, fonte, dados) VALUES ($1,$2,$3)
       ON CONFLICT (cnpj) DO UPDATE SET fonte = EXCLUDED.fonte, dados = EXCLUDED.dados, buscado_em = now()`,
      [cnpj, dados.fonte, JSON.stringify(dados)]);
  }
  return mesclar(carga, dados);
}

/** A consulta externa e mais completa; a carga mensal preenche o que faltar. */
function mesclar(carga: Cadastro | null, externo: Cadastro | null): Cadastro | null {
  if (!externo) return carga;
  if (!carga) return externo;
  const contatosUnicos = new Map<string, Contato>();
  for (const c of [...externo.contatos, ...carga.contatos]) contatosUnicos.set(`${c.tipo}:${c.valor}`, c);
  return {
    ...externo,
    contatos: [...contatosUnicos.values()],
    socios: externo.socios.length ? externo.socios : carga.socios,
  };
}
