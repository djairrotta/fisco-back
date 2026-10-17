/**
 * Quais programas de regularizacao cabem para uma empresa.
 *
 * E triagem, nao parecer: as regras do edital que dependem de dado que a
 * base publica nao tem (classe CAPAG, garantia, suspensao judicial) ficam
 * como "confirmar". O que da para checar com o dado publico e checado:
 * tipo do debito, valor, data de inscricao, porte/MEI, tempo de inscricao,
 * situacao do CNPJ e falencia/recuperacao no nome.
 *
 * O valor de desconto mostrado e o TETO legal sobre a parcela de divida que
 * o programa abrange. O desconto real depende da classificacao do devedor.
 */
import { q } from "../db/pool.js";

export interface Programa {
  slug: string; orgao: string; nome: string; tipo: string; base_legal: string; publico: string;
  debitos: string; desconto: string; entrada: string | null; parcelas: string; observacoes: string | null;
  adesao_inicio: string | null; adesao_fim: string | null; onde_aderir: string | null; fonte_url: string | null;
  verificado_em: string; regras: Regras; ordem: number;
}
interface Regras {
  origens?: string[]; valor_max?: number; valor_min?: number; inscritos_ate?: string; valor_max_inscricao?: number;
  portes?: number[]; mei?: boolean; so_mei?: boolean; perfil?: string;
  desconto_teto?: number; desconto_teto_diferenciado?: number;
}

export interface InscricaoResumo {
  origem: string; valor_consolidado: number | string; data_inscricao: string | null; tipo_devedor: number;
  situacao?: string | null;
}
/** Situacao da PGFN que indica acordo em curso: parcelamento, transacao, SISPAR, garantia, suspensao. */
export const RX_NEGOCIADA = /NEGOCIAD|NEGOCIACAO|INCLUSAO EM PARCELAMENTO|PARCELAD|TRANSA[CÇ]|SUSPENS|GARANTI|PENHORA REGULAR E SUFICIENTE/i;
/** "PARCELAMENTO RESCINDIDO" e o oposto de negociada: o acordo caiu. */
export const RX_RESCINDIDA = /RESCIND|RESCISAO/i;
export interface PerfilEmpresa {
  nome: string | null; porte: number | null; regime: string | null; situacao: number | null;
  inscricoes: InscricaoResumo[]; estadual_sp: boolean; uf: string | null;
}

export async function listarProgramas(): Promise<Programa[]> {
  return q<Programa>(`SELECT * FROM programa_regularizacao WHERE ativo ORDER BY ordem`);
}

export function situacaoPrograma(p: Pick<Programa, "adesao_inicio" | "adesao_fim">, agora = new Date()) {
  const fim = p.adesao_fim ? new Date(p.adesao_fim) : null;
  const ini = p.adesao_inicio ? new Date(p.adesao_inicio) : null;
  if (fim && fim < agora) return { estado: "encerrado" as const, dias: null };
  if (ini && ini > agora) return { estado: "em_breve" as const, dias: Math.ceil((+ini - +agora) / 864e5) };
  if (!fim) return { estado: "permanente" as const, dias: null };
  return { estado: "aberto" as const, dias: Math.ceil((+fim - +agora) / 864e5) };
}

const RX_FALENCIA = /\bFALID|MASSA FALIDA|EM LIQUIDACAO|LIQUIDACAO EXTRAJUDICIAL/;
const RX_RECUPERACAO = /RECUPERACAO JUDICIAL/;
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

/** Triagem de um programa contra o perfil. Exportada para teste. */
export function avaliar(p: Programa, e: PerfilEmpresa, agora = new Date()) {
  const r = p.regras || {};
  const nome = semAcento(e.nome || "");
  const motivos: string[] = [];
  const confirmar: string[] = [];

  // Debitos que o programa abrange
  const origensEmpresa = new Set(e.inscricoes.map((i) => i.origem));
  if (e.estadual_sp) origensEmpresa.add("ESTADUAL_SP");
  if (e.uf === "MG") confirmar.push("dívida estadual de MG só aparece por consulta de CNPJ");
  const origens = r.origens ?? [];
  const alvo = e.inscricoes.filter((i) => origens.includes(i.origem) && Number(i.tipo_devedor) === 1);
  const temOrigem = origens.some((o) => origensEmpresa.has(o));
  if (!temOrigem) return null;

  let abrangidas = alvo;
  if (r.inscritos_ate) {
    abrangidas = alvo.filter((i) => i.data_inscricao && i.data_inscricao.slice(0, 10) <= r.inscritos_ate!);
    if (alvo.length && !abrangidas.length) return null;
    if (abrangidas.length < alvo.length) {
      motivos.push(`${abrangidas.length} de ${alvo.length} inscrições foram feitas até ${r.inscritos_ate.split("-").reverse().join("/")}`);
    }
  }
  if (r.valor_max_inscricao) {
    const antes = abrangidas.length;
    abrangidas = abrangidas.filter((i) => Number(i.valor_consolidado) <= r.valor_max_inscricao!);
    if (antes && !abrangidas.length) return null;
    if (abrangidas.length < antes) motivos.push(`${abrangidas.length} de ${antes} inscrições estão no limite de valor`);
  }
  const valor = abrangidas.reduce((s, i) => s + Number(i.valor_consolidado || 0), 0);

  if (r.valor_max && valor > r.valor_max) return null;
  if (r.valor_min && valor <= r.valor_min) return null;

  const mei = e.regime === "mei";
  const meEpp = e.porte === 1 || e.porte === 3;
  if (r.so_mei) {
    if (e.regime == null) confirmar.push("confirmar se é MEI");
    else if (!mei) return null;
  }
  if (r.portes && !r.so_mei) {
    if (e.porte == null && e.regime == null) confirmar.push("confirmar porte (ME/EPP) ou MEI");
    else if (!(meEpp || (r.mei && mei))) return null;
  }

  const anos = (() => {
    const d = e.inscricoes.map((i) => i.data_inscricao).filter(Boolean).sort()[0];
    return d ? (+agora - +new Date(d)) / (365.25 * 864e5) : 0;
  })();
  const falencia = RX_FALENCIA.test(nome);
  const baixada = e.situacao != null && [3, 4, 8].includes(Number(e.situacao));
  if (r.perfil === "dificil_recuperacao") {
    const sinais: string[] = [];
    if (anos > 15) sinais.push(`inscrição há ${Math.floor(anos)} anos`);
    if (falencia) sinais.push("falência ou liquidação no nome");
    if (baixada) sinais.push("CNPJ baixado, inapto ou suspenso");
    if (!sinais.length) return null;
    motivos.push(...sinais);
    if (anos > 15 && !falencia && !baixada) confirmar.push("confirmar que não há garantia nem suspensão da exigibilidade");
  }

  const negociadas = abrangidas.filter((i) => !RX_RESCINDIDA.test(i.situacao || "") && RX_NEGOCIADA.test(i.situacao || "")).length;
  const rescindidas = abrangidas.filter((i) => RX_RESCINDIDA.test(i.situacao || "")).length;
  if (rescindidas) motivos.push(`${rescindidas} inscrição(ões) com parcelamento rescindido`);
  if (negociadas) confirmar.push(`${negociadas} das inscrições já estão negociadas ou suspensas (avaliar migração ou rescisão do acordo atual)`);

  const diferenciado = meEpp || mei || RX_RECUPERACAO.test(nome) || falencia;
  const teto = diferenciado && r.desconto_teto_diferenciado ? r.desconto_teto_diferenciado : r.desconto_teto ?? 0;
  if (diferenciado && r.desconto_teto_diferenciado) motivos.push("perfil diferenciado (teto maior e mais parcelas)");
  if (p.slug === "pgfn-6-2026-capacidade") confirmar.push("desconto depende da classe CAPAG (A e B não têm desconto)");
  if (alvo.some((i) => i.origem === "PGFN_PREV")) {
    if (p.orgao === "PGFN" && p.tipo !== "parcelamento") motivos.push("previdenciário sobre a folha: no máximo 60 parcelas");
  }

  return {
    slug: p.slug, nome: p.nome, orgao: p.orgao, tipo: p.tipo,
    ...situacaoPrograma(p, agora),
    adesao_fim: p.adesao_fim, onde_aderir: p.onde_aderir,
    valor_abrangido: origens.some((o) => o.startsWith("ESTADUAL")) ? null : valor,
    desconto_teto: teto || null,
    desconto_teto_valor: teto && valor ? Math.round(valor * teto * 100) / 100 : null,
    motivos, confirmar,
  };
}

export async function programasDaEmpresa(e: PerfilEmpresa) {
  const ps = await listarProgramas();
  return ps.map((p) => avaliar(p, e)).filter((x): x is NonNullable<ReturnType<typeof avaliar>> => !!x)
    .filter((x) => x.estado !== "encerrado");
}
