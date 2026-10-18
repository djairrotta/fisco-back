/**
 * Agendador de cargas.
 *
 * A instrucao era "alimentacao diaria". Rodar DIARIAMENTE esta certo;
 * BAIXAR diariamente nao. Conferido na propria fonte: a PGFN publica por
 * trimestre (2026_trimestre_03 ainda e 404) e a Receita por mes. Baixar
 * 1,4 GB todo dia para reprocessar arquivo identico gasta banda, disco e
 * janela de manutencao sem mudar um numero na tela.
 *
 * Entao: SONDA todo dia, CARREGA quando a origem muda. A sondagem e um
 * HEAD -- custa milissegundos. O estado fica em `fonte_dados`, nao em
 * memoria, porque memoria morre a cada deploy e o agendador voltaria a
 * achar que nunca carregou nada.
 *
 * Recuo progressivo em caso de falha: 1h, 2h, 4h... ate 24h. Fonte de
 * governo cai, e insistir de minuto em minuto so garante bloqueio de IP.
 */
import { pool, q } from "../db/pool.js";
import { env } from "../lib/env.js";
import { carregarBase, BASES, type Origem } from "./pgfn.js";
import { atualizarViews } from "./refresh-views.js";
import { rodarHistorico } from "./pgfn-historico.js";
import { versaoDisponivelReceita, carregarReceita, carregarSocios, carregarEmpresasSimples } from "./receita-cnpj.js";
import { carregarReceitaCompleta, periodoCompletoCarregado } from "./receita-completa.js";

const RAIZ_PGFN = "https://dadosabertos.pgfn.gov.br";

/** Trimestres do mais novo para o mais velho, a partir de hoje. */
export function trimestresCandidatos(hoje = new Date()): string[] {
  const out: string[] = [];
  let ano = hoje.getUTCFullYear();
  let tri = Math.floor(hoje.getUTCMonth() / 3) + 1;
  for (let i = 0; i < 6; i++) {
    out.push(`${ano}_trimestre_${String(tri).padStart(2, "0")}`);
    tri--; if (tri === 0) { tri = 4; ano--; }
  }
  return out;
}

/** Data de referencia = ultimo dia do trimestre da pasta. */
export function dataRefDoTrimestre(periodo: string): string {
  const m = /^(\d{4})_trimestre_(\d{2})$/.exec(periodo);
  if (!m) throw new Error(`periodo invalido: ${periodo}`);
  const ano = Number(m[1]), tri = Number(m[2]);
  const fim = new Date(Date.UTC(ano, tri * 3, 0));   // dia 0 do mes seguinte
  return fim.toISOString().slice(0, 10);
}

/** Sonda qual e o trimestre mais recente publicado, sem baixar nada. */
export async function versaoDisponivelPgfn(origem: Origem): Promise<string | null> {
  for (const p of trimestresCandidatos()) {
    try {
      const r = await fetch(`${RAIZ_PGFN}/${p}/${BASES[origem]}`, { method: "HEAD" });
      if (r.ok) return p;
    } catch { /* tenta o anterior */ }
  }
  return null;
}

async function marcarFalha(chave: string, erro: unknown) {
  const msg = String(erro instanceof Error ? erro.message : erro).slice(0, 400);
  await pool.query(
    `UPDATE fonte_dados
        SET falhas_seguidas = falhas_seguidas + 1,
            ultimo_erro = $2,
            -- recuo progressivo, teto de 24h
            proxima_tentativa = now() + (least(power(2, falhas_seguidas)::int, 24) || ' hours')::interval
      WHERE chave = $1`, [chave, msg]);
}

/** Processa uma fonte. Devolve true se carregou algo. */
async function cuidarDeUmaFonte(chave: string): Promise<boolean> {
  const [f] = await q<any>(`SELECT * FROM fonte_dados WHERE chave = $1`, [chave]);
  if (!f) return false;
  if (f.proxima_tentativa && new Date(f.proxima_tentativa) > new Date()) {
    console.log(`[agendador] ${chave}: em recuo até ${f.proxima_tentativa}`);
    return false;
  }

  try {
    const ehPgfn = chave.startsWith("PGFN_");
    const disponivel = ehPgfn
      ? await versaoDisponivelPgfn(chave as Origem)
      : await versaoDisponivelReceita();

    await pool.query(
      `UPDATE fonte_dados SET ultima_sondagem = now(), versao_disponivel = $2,
              falhas_seguidas = 0, ultimo_erro = NULL, proxima_tentativa = NULL
        WHERE chave = $1`, [chave, disponivel]);

    if (!disponivel) { console.log(`[agendador] ${chave}: nada publicado`); return false; }
    // Carga feita antes de o agendador existir (ou pela linha de comando)
    // nao gravou versao_carregada. Sem isto o agendador recarregaria 1,4 GB
    // que ja estao no banco. A tabela carga_etl sabe o que terminou bem.
    if (!f.versao_carregada && ehPgfn) {
      const [c] = await q<{ periodo: string }>(
        `SELECT periodo FROM carga_etl
          WHERE origem = $1 AND terminou_em IS NOT NULL AND erro IS NULL
          ORDER BY terminou_em DESC LIMIT 1`, [chave]);
      if (c) {
        f.versao_carregada = c.periodo;
        await pool.query(`UPDATE fonte_dados SET versao_carregada = $2 WHERE chave = $1`, [chave, c.periodo]);
      }
    }

    // Base completa: o que vale e a carga completa ter terminado no periodo
    // (a carga antiga, so das devedoras, tambem gravava versao_carregada).
    if (!ehPgfn && env.RECEITA_COMPLETA) f.versao_carregada = await periodoCompletoCarregado();
    if (disponivel === f.versao_carregada) {
      console.log(`[agendador] ${chave}: ${disponivel} já carregado`);
      return false;
    }

    console.log(`[agendador] ${chave}: ${f.versao_carregada ?? "nada"} -> ${disponivel}, carregando`);
    if (ehPgfn) {
      await carregarBase(chave as Origem, disponivel, dataRefDoTrimestre(disponivel));
    } else {
      // Cadastro (endereco, cidade, telefone, e-mail) e quadro societario:
      // os dois alimentam leads e cruzamentos, entao vao juntos.
      if (env.RECEITA_COMPLETA) await carregarReceitaCompleta(disponivel);
      else {
        await carregarReceita(disponivel);
        await carregarSocios(disponivel);
        await carregarEmpresasSimples(disponivel);
      }
    }
    await pool.query(
      `UPDATE fonte_dados SET versao_carregada = $2, ultima_carga = now() WHERE chave = $1`,
      [chave, disponivel]);
    return true;
  } catch (e) {
    console.error(`[agendador] ${chave} falhou:`, e instanceof Error ? e.message : e);
    await marcarFalha(chave, e);
    return false;
  }
}

/** Uma passada completa. Idempotente: pode rodar a qualquer hora. */
export async function rodarUmaVez() {
  // Em serie de proposito: duas cargas de 1 GB em paralelo competem por
  // disco e por conexao do banco, e nenhuma termina mais cedo por isso.
  // As views sao recalculadas DEPOIS DE CADA GRUPO: a divida federal
  // aparece na tela assim que a PGFN termina, sem esperar a hora de
  // download do cadastro da Receita.
  const grupos: string[][] = [];
  if (env.PGFN_AUTO) grupos.push(["PGFN_FGTS", "PGFN_PREV", "PGFN_GERAL"]);
  if (env.RECEITA_AUTO) grupos.push(["RECEITA_CNPJ"]);

  let mudouAlgo = false;
  for (const fontes of grupos) {
    let mudou = false;
    for (const c of fontes) if (await cuidarDeUmaFonte(c)) mudou = true;
    if (mudou) {
      console.log(`[agendador] ${fontes.join(", ")} mudou, recalculando views`);
      await atualizarViews();
      mudouAlgo = true;
    }
  }
  if (!mudouAlgo) console.log("[agendador] nada novo");
  // Serie historica: depois das cargas principais, nunca junto delas
  // (disco e conexao). Cada passada termina a fila pendente; trimestre
  // novo entra sozinho quando a PGFN publica.
  if (env.PGFN_HISTORICO) {
    const r = await rodarHistorico().catch((e) => { console.error("[pgfn-hist]", e); return null; });
    if (r?.feitos) console.log(`[pgfn-hist] ${r.feitos} trimestre(s) carregado(s)`);
  }
  return mudouAlgo;
}

export function iniciarAgendador() {
  if (!env.AGENDADOR_ATIVO) {
    console.log("[agendador] desligado (AGENDADOR_ATIVO=false)");
    return;
  }
  console.log(`[agendador] ligado, janela diária às ${env.AGENDADOR_HORA}h`);
  let ultimoDia: string | null = null;

  const tique = async () => {
    const agora = new Date();
    const dia = agora.toISOString().slice(0, 10);
    if (agora.getHours() < env.AGENDADOR_HORA || ultimoDia === dia) return;
    ultimoDia = dia;
    try { await rodarUmaVez(); }
    catch (e) { console.error("[agendador] passada falhou:", e); }
  };

  void tique();
  setInterval(() => void tique(), 60 * 60 * 1000).unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await rodarUmaVez();
  await pool.end();
}
