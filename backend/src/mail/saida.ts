// Caixa de saída: envios agendados e envios que falharam de forma
// transitória (tabela correio.saida). Um worker a cada 30 s, sob advisory
// lock (uma réplica por vez), envia os itens devidos pelo mesmo caminho do
// envio imediato (enviarMensagem). Falha transitória → nova tentativa em
// 1, 5 e 15 min; depois disso (ou falha permanente) → 'falhou' e push
// "Falha no envio". Enviado → o item (e os anexos em bytea) é apagado.
import type { Sql } from "../db/client.ts";
import { resumirErroMail } from "./conexao.ts";
import {
  AnexosGrandesDemais,
  ehErroTemporario,
  enviarMensagem,
  type EnvioDeps,
  FalhaEnvio,
  OriginalNaoEncontrado,
  type PedidoEnvio,
  type RefMensagem,
} from "./envio.ts";
import { MensagemGrandeDemais, PastaNaoEncontrada } from "./leitura.ts";
import { CaixaNaoEncontrada, CaixaPrecisaSenha } from "./pool.ts";
import type { PayloadPush } from "../notify/push.ts";
import { notificar, type TipoNotificacao } from "../notify/notificar.ts";

/**
 * `enviado` é interno: o SMTP aceitou e a linha só espera a limpeza; nunca
 * é reenviada nem aparece para o usuário.
 */
export type EstadoSaida = "pendente" | "enviando" | "falhou" | "enviado";

/** Motivo de um item que estava em envio quando o processo caiu. */
export const MOTIVO_INTERROMPIDO =
  "envio interrompido — verifique em Enviados antes de reenviar";
export type OrigemSaida = "agendado" | "falha";

/** Espera após a 1ª, 2ª e 3ª falha; a 4ª desiste. */
export const ESPERAS_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const INTERVALO_FILA_MS = 30_000;
/** pg advisory lock do worker (migrações usam 727275). */
export const TRAVA_FILA = 727276;
const MAX_POR_RODADA = 50;

export class SaidaOcupada extends Error {
  constructor() {
    super("Esta mensagem está sendo enviada agora; tente de novo em instantes");
    this.name = "SaidaOcupada";
  }
}

/** O pedido guardado (sem anexos, que ficam em saida_anexos). */
export type PedidoGuardado = Omit<PedidoEnvio, "anexos">;

export interface AnexoSaida {
  nome: string;
  tipo: string;
  tamanho: number;
}

export interface ItemSaida {
  id: number;
  caixaId: number;
  estado: EstadoSaida;
  origem: OrigemSaida;
  para: string[];
  cc: string[];
  cco: string[];
  assunto: string;
  respondendoA: RefMensagem | null;
  encaminhando: RefMensagem | null;
  incluirAssinatura: boolean;
  /** ISO; null quando entrou por falha de envio imediato. */
  agendarPara: string | null;
  /** ISO; quando o worker tenta (estado pendente). */
  proximaTentativa: string;
  tentativas: number;
  ultimoErro: string | null;
  anexos: AnexoSaida[];
  criadoEm: string;
  atualizadoEm: string;
}

export interface ItemSaidaCompleto extends ItemSaida {
  html: string;
  texto: string | null;
}

interface Linha {
  id: number;
  caixa_id: number;
  estado: EstadoSaida;
  origem: OrigemSaida;
  pedido: PedidoGuardado;
  agendar_para: Date | null;
  proxima_tentativa: Date;
  tentativas: number;
  ultimo_erro: string | null;
  criado_em: Date;
  atualizado_em: Date;
}

const isoOuNull = (d: Date | null) => d ? new Date(d).toISOString() : null;

function paraItem(l: Linha, anexos: AnexoSaida[]): ItemSaida {
  const p = l.pedido;
  return {
    id: l.id,
    caixaId: l.caixa_id,
    estado: l.estado,
    origem: l.origem,
    para: p.para ?? [],
    cc: p.cc ?? [],
    cco: p.cco ?? [],
    assunto: p.assunto ?? "",
    respondendoA: p.respondendoA ?? null,
    encaminhando: p.encaminhando ?? null,
    incluirAssinatura: p.incluirAssinatura ?? true,
    agendarPara: isoOuNull(l.agendar_para),
    proximaTentativa: new Date(l.proxima_tentativa).toISOString(),
    tentativas: l.tentativas,
    ultimoErro: l.ultimo_erro,
    anexos,
    criadoEm: new Date(l.criado_em).toISOString(),
    atualizadoEm: new Date(l.atualizado_em).toISOString(),
  };
}

function guardavel(p: PedidoEnvio | PedidoGuardado): PedidoGuardado {
  const g: PedidoGuardado = {
    para: p.para,
    cc: p.cc,
    cco: p.cco,
    assunto: p.assunto,
    html: p.html,
    incluirAssinatura: p.incluirAssinatura,
  };
  if (p.texto !== undefined) g.texto = p.texto;
  if (p.assinaturaId !== undefined) g.assinaturaId = p.assinaturaId;
  if (p.respondendoA) g.respondendoA = p.respondendoA;
  if (p.encaminhando) g.encaminhando = p.encaminhando;
  return g;
}

async function anexosDe(
  sql: Sql,
  ids: number[],
): Promise<Map<number, AnexoSaida[]>> {
  const m = new Map<number, AnexoSaida[]>();
  if (!ids.length) return m;
  const rs = await sql<
    { saida_id: number; nome: string; tipo: string; tamanho: number }[]
  >`
    SELECT saida_id, nome, tipo, octet_length(conteudo)::int AS tamanho
    FROM correio.saida_anexos WHERE saida_id = ANY(${ids}) ORDER BY saida_id, ordem`;
  for (const r of rs) {
    const xs = m.get(r.saida_id) ?? [];
    xs.push({ nome: r.nome, tipo: r.tipo, tamanho: r.tamanho });
    m.set(r.saida_id, xs);
  }
  return m;
}

// ------------------------------------------------------------ repositório

export interface OpcoesEnfileirar {
  origem: OrigemSaida;
  /** Quando o worker deve tentar (agendado: a hora escolhida). */
  quando: Date;
  agora: Date;
  /** Falhas já ocorridas (envio imediato que falhou: 1). */
  tentativas?: number;
  erro?: string;
}

/** Guarda o pedido e os anexos (bytea) numa transação. */
export async function enfileirar(
  sql: Sql,
  caixaId: number,
  p: PedidoEnvio,
  o: OpcoesEnfileirar,
): Promise<ItemSaida> {
  const id = await sql.begin(async (tx) => {
    const [r] = await tx<{ id: number }[]>`
      INSERT INTO correio.saida (caixa_id, origem, pedido, agendar_para,
        proxima_tentativa, tentativas, ultimo_erro, criado_em, atualizado_em)
      VALUES (${caixaId}, ${o.origem}, ${tx.json(guardavel(p) as never)},
        ${o.origem === "agendado" ? o.quando : null}, ${o.quando},
        ${o.tentativas ?? 0}, ${o.erro ?? null}, ${o.agora}, ${o.agora})
      RETURNING id`;
    for (const [i, a] of p.anexos.entries()) {
      await tx`
        INSERT INTO correio.saida_anexos (saida_id, ordem, nome, tipo, conteudo)
        VALUES (${r.id}, ${i}, ${a.nome}, ${a.tipo}, ${a.conteudo})`;
    }
    return r.id;
  });
  return (await obterSaida(sql, caixaId, id))!;
}

export async function listarSaida(
  sql: Sql,
  caixaId: number,
): Promise<ItemSaida[]> {
  const ls = await sql<Linha[]>`
    SELECT * FROM correio.saida
    WHERE caixa_id = ${caixaId} AND estado <> 'enviado'
    ORDER BY proxima_tentativa, id`;
  const ax = await anexosDe(sql, ls.map((l) => l.id));
  return ls.map((l) => paraItem(l, ax.get(l.id) ?? []));
}

export async function obterSaida(
  sql: Sql,
  caixaId: number,
  id: number,
): Promise<ItemSaidaCompleto | null> {
  const [l] = await sql<Linha[]>`
    SELECT * FROM correio.saida
    WHERE id = ${id} AND caixa_id = ${caixaId} AND estado <> 'enviado'`;
  if (!l) return null;
  const ax = await anexosDe(sql, [l.id]);
  return {
    ...paraItem(l, ax.get(l.id) ?? []),
    html: l.pedido.html ?? "",
    texto: l.pedido.texto ?? null,
  };
}

/** Lança SaidaOcupada se o item existe mas está em envio; senão null. */
async function ocupadaOuNula(
  sql: Sql,
  caixaId: number,
  id: number,
): Promise<null> {
  const [r] = await sql`
    SELECT 1 FROM correio.saida
    WHERE id = ${id} AND caixa_id = ${caixaId} AND estado = 'enviando'`;
  if (r) throw new SaidaOcupada();
  return null;
}

export interface AlteracaoSaida {
  para?: string[];
  cc?: string[];
  cco?: string[];
  assunto?: string;
  html?: string;
  texto?: string | null;
  incluirAssinatura?: boolean;
  /** Reagenda: volta a pendente, zera tentativas e erro. */
  agendarPara?: Date;
}

/**
 * Edita o conteúdo e/ou reagenda. Conteúdo sozinho não muda estado nem
 * horário. null se não existe; SaidaOcupada se está em envio.
 */
export async function editarSaida(
  sql: Sql,
  caixaId: number,
  id: number,
  a: AlteracaoSaida,
  agora: Date,
): Promise<ItemSaidaCompleto | null> {
  const ok = await sql.begin(async (tx) => {
    const [l] = await tx<Linha[]>`
      SELECT * FROM correio.saida
      WHERE id = ${id} AND caixa_id = ${caixaId}
        AND estado IN ('pendente', 'falhou')
      FOR UPDATE`;
    if (!l) return false;
    const p: PedidoGuardado = { ...l.pedido };
    if (a.para) p.para = a.para;
    if (a.cc) p.cc = a.cc;
    if (a.cco) p.cco = a.cco;
    if (a.assunto !== undefined) p.assunto = a.assunto;
    if (a.html !== undefined) p.html = a.html;
    if (a.texto === null) delete p.texto;
    else if (a.texto !== undefined) p.texto = a.texto;
    if (a.incluirAssinatura !== undefined) {
      p.incluirAssinatura = a.incluirAssinatura;
    }
    if (a.agendarPara) {
      await tx`
        UPDATE correio.saida SET pedido = ${tx.json(p as never)},
          agendar_para = ${a.agendarPara}, proxima_tentativa = ${a.agendarPara},
          origem = 'agendado', estado = 'pendente', tentativas = 0,
          ultimo_erro = NULL, atualizado_em = ${agora}
        WHERE id = ${id}`;
    } else {
      await tx`
        UPDATE correio.saida SET pedido = ${tx.json(p as never)},
          atualizado_em = ${agora}
        WHERE id = ${id}`;
    }
    return true;
  });
  if (!ok) return await ocupadaOuNula(sql, caixaId, id);
  return await obterSaida(sql, caixaId, id);
}

/** Cancela (apaga com os anexos). false se não existe. */
export async function cancelarSaida(
  sql: Sql,
  caixaId: number,
  id: number,
): Promise<boolean> {
  const r = await sql`
    DELETE FROM correio.saida
    WHERE id = ${id} AND caixa_id = ${caixaId}
      AND estado IN ('pendente', 'falhou')
    RETURNING id`;
  if (r.length) return true;
  await ocupadaOuNula(sql, caixaId, id);
  return false;
}

/** Põe o item para já, com as tentativas zeradas. null se não existe. */
export async function marcarParaJa(
  sql: Sql,
  caixaId: number,
  id: number,
  agora: Date,
): Promise<ItemSaida | null> {
  const r = await sql`
    UPDATE correio.saida SET estado = 'pendente', proxima_tentativa = ${agora},
      tentativas = 0, atualizado_em = ${agora}
    WHERE id = ${id} AND caixa_id = ${caixaId}
      AND estado IN ('pendente', 'falhou')
    RETURNING id`;
  if (!r.length) return await ocupadaOuNula(sql, caixaId, id);
  return await obterSaida(sql, caixaId, id);
}

// ------------------------------------------------------------ erros

/**
 * Vale repetir? Só erro de rede conhecido (ECONNREFUSED, ETIMEDOUT…) ou
 * SMTP 4xx. Senha, recusa 5xx, erros de domínio e qualquer erro
 * desconhecido (bug, banco) não são repetidos.
 */
export function ehTransitoria(e: unknown): boolean {
  if (e instanceof FalhaEnvio) return e.temporaria;
  if (ehErroConhecido(e)) return false;
  return ehErroTemporario(e);
}

/** Erros de domínio com resposta própria (não são "erro interno"). */
export function ehErroConhecido(e: unknown): boolean {
  return e instanceof FalhaEnvio ||
    e instanceof CaixaPrecisaSenha ||
    e instanceof CaixaNaoEncontrada ||
    e instanceof OriginalNaoEncontrado ||
    e instanceof AnexosGrandesDemais ||
    e instanceof MensagemGrandeDemais ||
    e instanceof PastaNaoEncontrada;
}

/** Texto pt-BR do erro, sem segredos. */
export function mensagemErro(e: unknown): string {
  if (
    e instanceof FalhaEnvio || e instanceof CaixaPrecisaSenha ||
    e instanceof OriginalNaoEncontrado || e instanceof AnexosGrandesDemais ||
    e instanceof MensagemGrandeDemais
  ) return e.message;
  if (e instanceof CaixaNaoEncontrada) return "Caixa não encontrada";
  if (e instanceof PastaNaoEncontrada) {
    return "Pasta da mensagem original não encontrada";
  }
  return `Falha ao acessar o servidor de e-mail: ${resumirErroMail(e)}`;
}

// ------------------------------------------------------------ worker

export type EnviarDaFila = (
  caixaId: number,
  pedido: PedidoEnvio,
) => Promise<unknown>;

export interface FilaDeps {
  sql: Sql;
  /** enviarMensagem(envioDeps, id, p, {pushFalha: "nunca"}) em produção. */
  enviar: EnviarDaFila;
  notificar: (
    tipo: TipoNotificacao,
    caixaId: number,
    payload: Omit<PayloadPush, "tipo">,
    opc?: { limitar?: boolean },
  ) => Promise<unknown>;
  agora?: () => Date;
  intervaloMs?: number;
}

export interface Rodada {
  /** false: outra réplica/rodada tinha a trava. */
  executou: boolean;
  enviados: number;
  reagendados: number;
  falharam: number;
}

export class FilaSaida {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private atual: Promise<Rodada> | null = null;
  private parada = true;
  private readonly agora: () => Date;

  constructor(private d: FilaDeps) {
    this.agora = d.agora ?? (() => new Date());
  }

  iniciar(): void {
    if (!this.parada) return;
    this.parada = false;
    this.agendar(0);
  }

  async parar(): Promise<void> {
    this.parada = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.atual?.catch(() => {});
  }

  private agendar(ms: number) {
    if (this.parada) return;
    this.timer = setTimeout(async () => {
      try {
        await this.executar();
      } catch (e) {
        console.error(
          "[saida] rodada falhou:",
          (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
        );
      }
      this.agendar(this.d.intervaloMs ?? INTERVALO_FILA_MS);
    }, ms);
  }

  /** Uma rodada (serializada no processo; entre réplicas, pela trava). */
  executar(): Promise<Rodada> {
    const antes = this.atual ?? Promise.resolve();
    const p = antes.catch(() => {}).then(() => this.rodada());
    this.atual = p;
    const limpar = () => {
      if (this.atual === p) this.atual = null;
    };
    p.then(limpar, limpar);
    return p;
  }

  private async rodada(): Promise<Rodada> {
    const r: Rodada = {
      executou: false,
      enviados: 0,
      reagendados: 0,
      falharam: 0,
    };
    const { sql } = this.d;
    const conexao = await sql.reserve();
    try {
      const [t] = await conexao`
        SELECT pg_try_advisory_lock(${TRAVA_FILA}) AS ok`;
      if (!t.ok) return r;
      r.executou = true;
      try {
        // com a trava, nenhum outro worker está enviando: 'enviando' que
        // sobrou é de um processo que caiu no meio — talvez DEPOIS do SMTP
        // aceitar. Nunca volta sozinho a pendente: o usuário confere.
        await sql`
          UPDATE correio.saida SET estado = 'falhou',
            ultimo_erro = ${MOTIVO_INTERROMPIDO},
            atualizado_em = ${this.agora()}
          WHERE estado = 'enviando'`;
        await this.limparEnviados();
        for (let i = 0; i < MAX_POR_RODADA; i++) {
          if (!await this.proximo(r)) break;
        }
      } finally {
        await conexao`SELECT pg_advisory_unlock(${TRAVA_FILA})`;
      }
    } finally {
      conexao.release();
    }
    return r;
  }

  /** Envia o próximo item devido; false se não há. */
  private async proximo(r: Rodada): Promise<boolean> {
    const { sql } = this.d;
    const agora = this.agora();
    const [l] = await sql<Linha[]>`
      UPDATE correio.saida SET estado = 'enviando', atualizado_em = ${agora}
      WHERE id = (
          SELECT id FROM correio.saida
          WHERE estado = 'pendente' AND proxima_tentativa <= ${agora}
          ORDER BY proxima_tentativa, id LIMIT 1
          FOR UPDATE SKIP LOCKED)
        AND estado = 'pendente' AND proxima_tentativa <= ${agora}
      RETURNING *`;
    if (!l) return false;
    const anexos = await sql<
      { nome: string; tipo: string; conteudo: Uint8Array }[]
    >`
      SELECT nome, tipo, conteudo FROM correio.saida_anexos
      WHERE saida_id = ${l.id} ORDER BY ordem`;
    let res: unknown;
    try {
      res = await this.d.enviar(l.caixa_id, {
        ...l.pedido,
        anexos: anexos.map((a) => ({
          nome: a.nome,
          tipo: a.tipo,
          conteudo: new Uint8Array(a.conteudo),
        })),
      });
    } catch (e) {
      await this.falhou(l, e);
      if (ehTransitoria(e) && l.tentativas + 1 <= ESPERAS_MS.length) {
        r.reagendados++;
      } else r.falharam++;
      return true;
    }
    // o SMTP aceitou: primeiro grava 'enviado' (nunca mais é reenviado),
    // depois limpa (linha e anexos); limpeza que falha não reenvia
    const mid = (res as { messageId?: unknown } | null)?.messageId;
    await sql`
      UPDATE correio.saida SET estado = 'enviado',
        message_id = ${typeof mid === "string" ? mid : null},
        atualizado_em = ${this.agora()}
      WHERE id = ${l.id}`;
    r.enviados++;
    await this.limparEnviados(l.id);
    return true;
  }

  /** Apaga linhas 'enviado' (e anexos); falha só é registrada. */
  private async limparEnviados(id?: number): Promise<void> {
    const { sql } = this.d;
    try {
      if (id === undefined) {
        await sql`DELETE FROM correio.saida WHERE estado = 'enviado'`;
      } else {
        await sql`
          DELETE FROM correio.saida WHERE id = ${id} AND estado = 'enviado'`;
      }
    } catch (e) {
      console.error(
        "[saida] limpeza de enviados falhou (fica para a próxima rodada):",
        (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
      );
    }
  }

  private async falhou(l: Linha, e: unknown): Promise<void> {
    const { sql } = this.d;
    const n = l.tentativas + 1;
    const erro = mensagemErro(e).slice(0, 500);
    const agora = this.agora();
    console.error(
      `[saida] item ${l.id}: tentativa ${n} falhou:`,
      (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
    );
    if (ehTransitoria(e) && n <= ESPERAS_MS.length) {
      const quando = new Date(agora.getTime() + ESPERAS_MS[n - 1]);
      await sql`
        UPDATE correio.saida SET estado = 'pendente', tentativas = ${n},
          proxima_tentativa = ${quando}, ultimo_erro = ${erro},
          atualizado_em = ${agora}
        WHERE id = ${l.id}`;
      return;
    }
    await sql`
      UPDATE correio.saida SET estado = 'falhou', tentativas = ${n},
        ultimo_erro = ${erro}, atualizado_em = ${agora}
      WHERE id = ${l.id}`;
    const [cx] = await sql<{ endereco: string; tem_logo: boolean }[]>`
      SELECT endereco, logo IS NOT NULL AS tem_logo
      FROM correio.caixas WHERE id = ${l.caixa_id}`;
    if (!cx) return;
    try {
      await this.d.notificar("falha", l.caixa_id, {
        titulo: "Falha no envio",
        corpo: `${
          l.pedido.assunto || "(sem assunto)"
        } — ${cx.endereco}: ${erro}`,
        url: `/c/${l.caixa_id}/saida`,
        tag: `saida-${l.id}`,
        ...(cx.tem_logo ? { icone: `/api/marca/${l.caixa_id}/logo` } : {}),
      }, { limitar: false });
    } catch { /* notificar nunca lança; por garantia */ }
  }
}

/**
 * Worker de produção: envia pelo mesmo caminho do envio imediato, sem push
 * de falha por tentativa (a fila avisa uma vez, quando desiste).
 */
export function filaPadrao(
  envio: EnvioDeps,
  opc: { intervaloMs?: number } = {},
): FilaSaida {
  return new FilaSaida({
    sql: envio.sql,
    agora: envio.agora,
    intervaloMs: opc.intervaloMs,
    enviar: (id, p) => enviarMensagem(envio, id, p, { pushFalha: "nunca" }),
    notificar: (tipo, id, payload, o) =>
      notificar(tipo, id, payload, envio.notificacao, o),
  });
}
