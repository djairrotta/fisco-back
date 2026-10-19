// Vigia da caixa de entrada: uma conexão IMAP dedicada por caixa (fora do
// pool das rotas), em IDLE na INBOX. Mensagens novas (UID > último visto)
// viram push `recebido`, depois de passar pelo classificador (até 5 s).
//
// - Primeira execução, ou UIDVALIDITY diferente: grava o UID atual sem push.
// - EXISTS dispara uma sincronia; a cada 2 min há uma varredura por UID.
// - O último UID é avançado no banco ANTES do push (nunca duplica).
// - Queda: backoff 5 s → 5 min; o contador só zera após 60 s de sessão. Da
//   3ª falha seguida em diante: estado `erro` e push `falha` "Caixa X sem
//   conexão" (limitado a 1 por 30 min; se limitado, tenta na falha seguinte);
//   quando volta, push "Caixa X reconectada" (só se o aviso de queda chegou)
//   e `ok` só se o `erro` foi posto pelo vigia.
// - Senha recusada: estado `precisa_senha`, um push de falha e o vigia para
//   (sem novas tentativas, para não bloquear a conta no poste.io).
// - Endereço e logo são relidos do banco a cada push.
import type { ImapFlow } from "imapflow";
import PostalMime, { type Email } from "postal-mime";
import type { Sql } from "../db/client.ts";
import {
  lerSenha,
  MOTIVO_SENHA_ILEGIVEL,
  SenhaIlegivel,
} from "../caixas/repo.ts";
import {
  abrirImap,
  type CaixaLogin,
  type ConfigMail,
  ehFalhaAutenticacao,
} from "./conexao.ts";
import {
  disparar,
  notificacaoAtiva,
  type ResultadoNotificar,
  type TipoNotificacao,
} from "../notify/notificar.ts";
import type { PayloadPush } from "../notify/push.ts";
import { comPrazo, suspeitaDe, type Veredito } from "../ai/classificador.ts";
import {
  type AreaRegistro,
  type NivelRegistro,
  type Registrador,
} from "../db/registro.ts";

export const PASTA_VIGIADA = "INBOX";
export const BACKOFF_INICIAL_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const VARREDURA_MS = 2 * 60_000;
export const FALHAS_PARA_AVISO = 3;
/** Sessão que dura isto zera o contador de falhas (evita flapping rápido). */
export const SESSAO_ESTAVEL_MS = 60_000;
export const PRAZO_CLASSIFICACAO_MS = 5_000;
/** Acima disso, um push de resumo em vez de um por mensagem. */
export const MAX_PUSH_INDIVIDUAIS = 5;
/** Quanto da fonte buscar para o classificador (cabeçalhos + início). */
export const FONTE_MAX_BYTES = 256 * 1024;
const LOGOUT_MS = 5_000;

/** Espera antes da n-ésima tentativa após n falhas seguidas (n ≥ 1). */
export function atrasoBackoff(
  falhas: number,
  base = BACKOFF_INICIAL_MS,
  max = BACKOFF_MAX_MS,
): number {
  const n = Math.max(1, falhas);
  return Math.min(max, base * 2 ** Math.min(n - 1, 30));
}

export interface MensagemNova {
  uid: number;
  de: { nome: string; endereco: string } | null;
  assunto: string;
  /** Início da mensagem interpretado (para o classificador); null se falhou. */
  email: Email | null;
}

/** O que o vigia precisa de uma conexão IMAP (fácil de simular nos testes). */
export interface ConexaoVigia {
  /** Estado da INBOX no SELECT. */
  inbox: { uidValidity: string; uidNext: number };
  /** UIDs maiores que `desde`, em ordem crescente. */
  uidsDesde(desde: number): Promise<number[]>;
  buscar(uids: number[]): Promise<MensagemNova[]>;
  /** Chamado a cada EXISTS do servidor (IDLE). */
  aoExistir(fn: () => void): void;
  /** Resolve quando a conexão cai ou é fechada. */
  fechada: Promise<void>;
  fechar(): Promise<void>;
}

export type AbrirConexaoVigia = (
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
) => Promise<ConexaoVigia>;

/** Tempo e espera, injetáveis (testes sem esperas reais). */
export interface Relogio {
  agora(): Date;
  /** Resolve após `ms` ou quando `sinal` aborta (o que vier antes). */
  dormir(ms: number, sinal: AbortSignal): Promise<void>;
}

export const relogioReal: Relogio = {
  agora: () => new Date(),
  dormir: (ms, sinal) =>
    new Promise<void>((res) => {
      if (sinal.aborted) return res();
      const t = setTimeout(() => {
        sinal.removeEventListener("abort", fim);
        res();
      }, ms);
      const fim = () => {
        clearTimeout(t);
        res();
      };
      sinal.addEventListener("abort", fim, { once: true });
    }),
};

export type FuncaoNotificar = (
  tipo: TipoNotificacao,
  caixaId: number,
  payload: Omit<PayloadPush, "tipo">,
  opc?: { limitar?: boolean },
) => Promise<ResultadoNotificar>;

export type FuncaoClassificar = (
  caixaId: number,
  pasta: string,
  uidValidity: string,
  uid: number,
  email: Email,
) => Promise<Veredito | null>;

export interface DepsVigia {
  sql: Sql;
  masterKey: Uint8Array;
  mail: ConfigMail;
  /** notificar(…) com as NotificarDeps de produção (fire-and-forget aqui). */
  notificar: FuncaoNotificar;
  /** Classificador (cache + OpenRouter); sem ele, push sem aviso. */
  classificar?: FuncaoClassificar;
  /** Padrão: conexão IMAP real (abrirConexaoVigia). */
  abrir?: AbrirConexaoVigia;
  /** Logger de atividade/erro (tabela correio.registro); ausente → não registra. */
  registro?: Registrador;
  relogio?: Relogio;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  varreduraMs?: number;
  prazoClassificacaoMs?: number;
}

function codigo(e: unknown): string {
  return String(
    (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
  );
}

/** Logout educado com prazo; se travar ou falhar, fecha o socket. */
async function encerrar(c: ImapFlow): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      c.logout(),
      new Promise((_, rej) => {
        t = setTimeout(() => rej(new Error("logout")), LOGOUT_MS);
      }),
    ]);
  } catch {
    try {
      c.close();
    } catch { /* já fechado */ }
  } finally {
    clearTimeout(t);
  }
}

/** Conexão IMAP real (imapflow): INBOX selecionada, IDLE automático. */
export const abrirConexaoVigia: AbrirConexaoVigia = async (
  cfg,
  caixa,
  senha,
) => {
  const c = await abrirImap(cfg, caixa, senha);
  let soltar!: () => void;
  const fechada = new Promise<void>((r) => soltar = r);
  let aoExistir: (() => void) | null = null;
  c.on("close", () => soltar());
  c.on("error", (e: unknown) => {
    console.error("[vigia] erro IMAP:", codigo(e));
    soltar();
    try {
      c.close();
    } catch { /* já fechado */ }
  });
  c.on("exists", () => aoExistir?.());
  // o IDLE automático do imapflow só começa 15 s após o último comando; sem
  // IDLE o servidor não avisa EXISTS. Entra em IDLE logo após cada comando
  // (o próximo comando o interrompe sozinho).
  const ocioso = () => {
    c.idle().catch(() => {});
  };
  let mb;
  try {
    mb = await c.mailboxOpen(PASTA_VIGIADA);
  } catch (e) {
    try {
      c.close();
    } catch { /* já fechado */ }
    throw e;
  }
  ocioso();
  return {
    inbox: { uidValidity: String(mb.uidValidity), uidNext: mb.uidNext ?? 0 },
    async uidsDesde(desde) {
      const r = await c.search({ uid: `${desde + 1}:*` }, { uid: true });
      ocioso();
      // "n:*" com n acima do maior UID devolve a última mensagem: filtrar
      return (r || []).filter((u) => u > desde).sort((a, b) => a - b);
    },
    async buscar(uids) {
      const out: MensagemNova[] = [];
      if (!uids.length) return out;
      try {
        return await buscarFonte(uids, out);
      } finally {
        ocioso();
      }
    },
    aoExistir(fn) {
      aoExistir = fn;
    },
    fechada,
    async fechar() {
      await encerrar(c);
      soltar();
    },
  };

  async function buscarFonte(uids: number[], out: MensagemNova[]) {
    for await (
      const m of c.fetch(uids.join(","), {
        uid: true,
        envelope: true,
        source: { maxLength: FONTE_MAX_BYTES },
      }, { uid: true })
    ) {
      let email: Email | null = null;
      if (m.source) {
        try {
          email = await PostalMime.parse(new Uint8Array(m.source));
        } catch { /* sem classificação */ }
      }
      const de = m.envelope?.from?.[0];
      out.push({
        uid: m.uid,
        de: de ? { nome: de.name ?? "", endereco: de.address ?? "" } : null,
        assunto: m.envelope?.subject ?? "",
        email,
      });
    }
    return out.sort((a, b) => a.uid - b.uid);
  }
};

interface InfoCaixa {
  endereco: string;
  senha: string;
  senhaCifrada: string;
  estado: string;
}

// deno-lint-ignore no-control-regex
const CONTROLE = /[\x00-\x1f\x7f]+/g;
const limpo = (s: string, max = 200) =>
  s.replace(CONTROLE, " ").trim().slice(0, max);

/** Um vigia por caixa. `iniciar` dispara o laço; `parar` encerra e espera. */
export class VigiaCaixa {
  readonly id: number;
  private d: DepsVigia;
  private relogio: Relogio;
  private abrir: AbrirConexaoVigia;
  private laco: Promise<void> | null = null;
  private parando = new AbortController();
  /** Falhas seguidas; só zera após uma sessão estável (≥ 60 s). */
  private falhas = 0;
  /** O push "sem conexão" chegou a um aparelho (então avisa a volta). */
  private avisadoSemConexao = false;
  private avisoEmVoo = false;
  /** O estado `erro` atual foi posto por este vigia (só então volta a ok). */
  private marcouErro = false;
  private _rodando = false;

  constructor(id: number, deps: DepsVigia) {
    this.id = id;
    this.d = deps;
    this.relogio = deps.relogio ?? relogioReal;
    this.abrir = deps.abrir ?? abrirConexaoVigia;
  }

  /** true enquanto o laço roda (false após precisa_senha, remoção ou parar). */
  get rodando(): boolean {
    return this._rodando;
  }

  iniciar(): void {
    if (this.laco) return;
    this._rodando = true;
    this.laco = this.executar().catch((e) => {
      console.error(`[vigia] caixa ${this.id}: laço encerrado:`, codigo(e));
      this.registrar("erro", "sistema", `Vigia da caixa encerrou com erro`, {
        code: codigo(e),
      });
    }).finally(() => {
      this._rodando = false;
    });
  }

  async parar(): Promise<void> {
    this.parando.abort();
    await this.laco;
  }

  private get parado() {
    return this.parando.signal.aborted;
  }

  private async carregar(): Promise<InfoCaixa | null> {
    const [c] = await this.d.sql<
      { estado: string; senha_cifrada: string }[]
    >`SELECT estado, senha_cifrada FROM correio.caixas WHERE id = ${this.id}`;
    if (!c) return null;
    const cred = await lerSenha(this.d.sql, this.d.masterKey, this.id);
    if (!cred) return null;
    return {
      endereco: cred.endereco,
      senha: cred.senha,
      senhaCifrada: c.senha_cifrada,
      estado: c.estado,
    };
  }

  /** Endereço e logo atuais, relidos a cada push; null se a caixa sumiu. */
  private async dadosPush(
    reserva: string,
  ): Promise<{ endereco: string; icone?: string } | null> {
    try {
      const [c] = await this.d.sql<{ endereco: string; tem_logo: boolean }[]>`
        SELECT endereco, logo IS NOT NULL AS tem_logo FROM correio.caixas
        WHERE id = ${this.id}`;
      if (!c) return null;
      return {
        endereco: c.endereco,
        ...(c.tem_logo ? { icone: `/api/marca/${this.id}/logo` } : {}),
      };
    } catch {
      return { endereco: reserva };
    }
  }

  private async executar(): Promise<void> {
    while (!this.parado) {
      let info: InfoCaixa | null;
      try {
        info = await this.carregar();
      } catch (e) {
        if (e instanceof SenhaIlegivel) {
          // chave mestra trocada: lerSenha já marcou precisa_senha
          console.error(
            `[vigia] caixa ${this.id}: senha ilegível; vigia parado`,
          );
          await this.avisarSenha(MOTIVO_SENHA_ILEGIVEL, "");
          return;
        }
        console.error(`[vigia] caixa ${this.id}: banco:`, codigo(e));
        await this.dormir(atrasoBackoff(1, this.base, this.max));
        continue;
      }
      if (!info) return; // caixa removida
      if (info.estado === "precisa_senha") return;

      let conn: ConexaoVigia;
      try {
        conn = await this.abrir(
          this.d.mail,
          { endereco: info.endereco },
          info.senha,
        );
      } catch (e) {
        if (ehFalhaAutenticacao(e)) {
          this.registrar(
            "erro",
            "auth",
            `IMAP recusou a senha de ${info.endereco}`,
          );
          await this.senhaRecusada(info);
          return;
        }
        console.error(
          `[vigia] caixa ${this.id}: falha ao conectar:`,
          codigo(e),
        );
        this.registrar(
          "aviso",
          "imap",
          `Falha ao conectar a INBOX de ${info.endereco}`,
          { code: codigo(e) },
        );
        await this.falhou(info);
        continue;
      }
      this.registrar("info", "imap", `INBOX conectada: ${info.endereco}`);

      if (this.parado) {
        await conn.fechar().catch(() => {});
        return;
      }
      let estavelDesde: number | null = null;
      try {
        await this.sessao(conn, info, (t) => estavelDesde = t);
      } catch (e) {
        console.error(`[vigia] caixa ${this.id}: conexão perdida:`, codigo(e));
        this.registrar(
          "aviso",
          "imap",
          `Conexão IMAP perdida: ${info.endereco}`,
          { code: codigo(e) },
        );
      } finally {
        await conn.fechar().catch(() => {});
      }
      if (this.parado) return;
      if (
        estavelDesde !== null &&
        this.relogio.agora().getTime() - estavelDesde >= SESSAO_ESTAVEL_MS
      ) {
        this.falhas = 0;
      }
      await this.falhou(info);
    }
  }

  /**
   * Senha recusada: precisa_senha (só se a senha ainda é a usada, para não
   * sobrescrever uma troca feita no meio) e um push de falha, pelo limite.
   */
  private async senhaRecusada(info: InfoCaixa): Promise<void> {
    const r = await this.d.sql`
      UPDATE correio.caixas SET estado = 'precisa_senha'
      WHERE id = ${this.id} AND senha_cifrada = ${info.senhaCifrada}`;
    console.error(`[vigia] caixa ${this.id}: senha recusada; vigia parado`);
    if (r.count !== 1) return;
    await this.avisarSenha(
      "senha recusada — edite a caixa no Correio",
      info.endereco,
    );
  }

  /** Um push `falha` (pelo limite) "Caixa X: <texto>"; nunca repetido. */
  private async avisarSenha(texto: string, reserva: string): Promise<void> {
    const dp = await this.dadosPush(reserva);
    if (!dp) return;
    disparar(this.d.notificar("falha", this.id, {
      titulo: `Caixa ${dp.endereco}: ${texto}`,
      corpo: "Edite a caixa e digite a senha. O Correio parou de tentar.",
      url: `/c/${this.id}`,
      tag: `conexao-${this.id}`,
    }));
  }

  private get base() {
    return this.d.backoffBaseMs ?? BACKOFF_INICIAL_MS;
  }
  private get max() {
    return this.d.backoffMaxMs ?? BACKOFF_MAX_MS;
  }

  private dormir(ms: number): Promise<void> {
    return this.relogio.dormir(ms, this.parando.signal);
  }

  /** Log best-effort (fire-and-forget; nunca lança). */
  private registrar(
    nivel: NivelRegistro,
    area: AreaRegistro,
    mensagem: string,
    detalhe?: Record<string, unknown>,
  ): void {
    void this.d.registro?.registrar({
      nivel,
      area,
      caixaId: this.id,
      mensagem,
      ...(detalhe ? { detalhe } : {}),
    });
  }

  /**
   * Conta a falha e espera o backoff. A partir da 3ª seguida: estado `erro`
   * e push "sem conexão" — se o limite de 30 min o segurou (ou não chegou a
   * ninguém), tenta de novo na falha seguinte, até sair uma vez.
   */
  private async falhou(info: InfoCaixa): Promise<void> {
    this.falhas++;
    if (this.falhas >= FALHAS_PARA_AVISO) {
      if (!this.marcouErro) {
        try {
          const r = await this.d.sql`
            UPDATE correio.caixas SET estado = 'erro'
            WHERE id = ${this.id} AND estado = 'ok'`;
          if (r.count === 1) this.marcouErro = true;
        } catch { /* best-effort */ }
      }
      if (!this.avisadoSemConexao && !this.avisoEmVoo) {
        this.avisoEmVoo = true;
        disparar(
          (async () => {
            const dp = await this.dadosPush(info.endereco);
            if (!dp) return;
            const r = await this.d.notificar("falha", this.id, {
              titulo: `Caixa ${dp.endereco} sem conexão`,
              corpo: "Tentando reconectar automaticamente.",
              url: `/c/${this.id}`,
              tag: `conexao-${this.id}`,
            });
            if (r === "enviado") this.avisadoSemConexao = true;
          })().finally(() => this.avisoEmVoo = false),
        );
      }
    }
    await this.dormir(atrasoBackoff(this.falhas, this.base, this.max));
  }

  /** Conexão estabelecida: sincronia inicial, depois EXISTS e varreduras. */
  private async sessao(
    conn: ConexaoVigia,
    info: InfoCaixa,
    estavel: (desdeMs: number) => void,
  ): Promise<void> {
    let pendente = false;
    let caiu = false;
    let acordar: AbortController | null = null;
    conn.aoExistir(() => {
      pendente = true;
      acordar?.abort();
    });
    conn.fechada.then(() => {
      caiu = true;
      acordar?.abort();
    });

    await this.sincronizar(conn, info);
    estavel(this.relogio.agora().getTime());
    await this.recuperou(info);

    const varredura = this.d.varreduraMs ?? VARREDURA_MS;
    while (!this.parado && !caiu) {
      if (!pendente) {
        acordar = new AbortController();
        const sinal = AbortSignal.any([
          acordar.signal,
          this.parando.signal,
        ]);
        await this.relogio.dormir(varredura, sinal);
        acordar = null;
      }
      if (this.parado || caiu) return;
      pendente = false;
      await this.sincronizar(conn, info);
    }
  }

  private async recuperou(info: InfoCaixa): Promise<void> {
    if (this.marcouErro) {
      this.marcouErro = false;
      try {
        await this.d.sql`
          UPDATE correio.caixas SET estado = 'ok'
          WHERE id = ${this.id} AND estado = 'erro'`;
      } catch { /* best-effort */ }
    }
    if (this.avisadoSemConexao) {
      this.avisadoSemConexao = false;
      const dp = await this.dadosPush(info.endereco);
      if (!dp) return;
      disparar(
        this.d.notificar("falha", this.id, {
          titulo: `Caixa ${dp.endereco} reconectada`,
          corpo: "A conexão com o servidor voltou.",
          url: `/c/${this.id}`,
          tag: `conexao-${this.id}`,
        }, { limitar: false }),
      );
    }
  }

  /** Compara com estado_imap e notifica os UIDs novos. */
  private async sincronizar(
    conn: ConexaoVigia,
    info: InfoCaixa,
  ): Promise<void> {
    const { sql } = this.d;
    const { uidValidity, uidNext } = conn.inbox;
    const [linha] = await sql<
      { uidvalidity: string | null; ultimo_uid: string }[]
    >`SELECT uidvalidity::text, ultimo_uid::text FROM correio.estado_imap
      WHERE caixa_id = ${this.id} AND pasta = ${PASTA_VIGIADA}`;

    if (!linha || linha.uidvalidity !== uidValidity) {
      // primeira vez ou caixa recriada no servidor: só marca o ponto atual
      const atual = Math.max(0, uidNext - 1);
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO correio.estado_imap (caixa_id, pasta, uidvalidity, ultimo_uid)
          VALUES (${this.id}, ${PASTA_VIGIADA}, ${uidValidity}, ${atual})
          ON CONFLICT (caixa_id, pasta) DO UPDATE
          SET uidvalidity = EXCLUDED.uidvalidity, ultimo_uid = EXCLUDED.ultimo_uid`;
        if (linha) {
          // vereditos da UIDVALIDITY antiga não servem mais (limpeza)
          await tx`DELETE FROM correio.classificacoes
            WHERE caixa_id = ${this.id} AND pasta = ${PASTA_VIGIADA}
              AND uidvalidity <> ${uidValidity}`;
        }
      });
      if (linha) {
        console.error(
          `[vigia] caixa ${this.id}: UIDVALIDITY mudou; reiniciado sem push`,
        );
      }
      return;
    }

    const ultimo = Number(linha.ultimo_uid);
    const novos = (await conn.uidsDesde(ultimo)).filter((u) => u > ultimo);
    if (!novos.length) return;
    const maior = novos[novos.length - 1];
    // avança antes do push; se outro avançou primeiro, não notifica de novo
    const r = await sql`
      UPDATE correio.estado_imap SET ultimo_uid = ${maior}
      WHERE caixa_id = ${this.id} AND pasta = ${PASTA_VIGIADA}
        AND ultimo_uid = ${ultimo} AND uidvalidity = ${uidValidity}`;
    if (r.count !== 1) return;

    if (novos.length > MAX_PUSH_INDIVIDUAIS) {
      disparar((async () => {
        const dp = await this.dadosPush(info.endereco);
        if (!dp) return;
        await this.d.notificar("recebido", this.id, {
          titulo: `${novos.length} novos e-mails`,
          corpo: dp.endereco,
          url: `/c/${this.id}`,
          ...(dp.icone ? { icone: dp.icone } : {}),
          tag: `recebido-${this.id}`,
        });
      })());
      return;
    }
    let msgs: MensagemNova[];
    try {
      msgs = await conn.buscar(novos);
    } catch (e) {
      console.error(`[vigia] caixa ${this.id}: falha ao buscar:`, codigo(e));
      msgs = novos.map((uid) => ({ uid, de: null, assunto: "", email: null }));
    }
    for (const m of msgs) {
      disparar(this.notificarRecebido(info, uidValidity, m));
    }
  }

  private async notificarRecebido(
    info: InfoCaixa,
    uidValidity: string,
    m: MensagemNova,
  ): Promise<void> {
    // recebido desligado para a caixa: nem classifica (custo do OpenRouter)
    if (!await notificacaoAtiva(this.d.sql, "recebido", this.id)) return;
    let v: Veredito | null = null;
    if (this.d.classificar && m.email) {
      v = await comPrazo(
        this.d.classificar(this.id, PASTA_VIGIADA, uidValidity, m.uid, m.email),
        this.d.prazoClassificacaoMs ?? PRAZO_CLASSIFICACAO_MS,
      );
    }
    const s = suspeitaDe(v);
    const aviso = s
      ? (s.classe === "phishing"
        ? "⚠️ possível phishing: "
        : "⚠️ possível spam: ")
      : "";
    const titulo = limpo(m.de?.nome ?? "") || limpo(m.de?.endereco ?? "") ||
      "Remetente desconhecido";
    const assunto = limpo(m.assunto) || "(sem assunto)";
    const dp = await this.dadosPush(info.endereco);
    if (!dp) return;
    await this.d.notificar("recebido", this.id, {
      titulo,
      corpo: `${aviso}${assunto}\n${dp.endereco}`,
      url: `/c/${this.id}/m/${PASTA_VIGIADA}/${m.uid}`,
      ...(dp.icone ? { icone: dp.icone } : {}),
      tag: `recebido-${this.id}-${m.uid}`,
    });
  }
}

/** Interface mínima usada pelas rotas de caixas. */
export interface SincronizadorCaixas {
  sync(caixaId: number): Promise<void>;
}

/**
 * Um vigia por caixa em `ok` ou `erro`. `sync(id)` após criar, editar ou
 * remover: inicia, reinicia (senha trocada ou vigia parado) ou para.
 */
export class GerenciadorCaixas implements SincronizadorCaixas {
  private vigias = new Map<
    number,
    { vigia: VigiaCaixa; senhaCifrada: string }
  >();
  private filas = new Map<number, Promise<void>>();
  private parado = false;

  constructor(private d: DepsVigia) {}

  async start(): Promise<void> {
    this.parado = false;
    const ids = await this.d.sql<{ id: number }[]>`
      SELECT id FROM correio.caixas ORDER BY id`;
    await Promise.all(ids.map((r) => this.sync(r.id)));
  }

  /** Ids com vigia rodando. */
  vigiadas(): number[] {
    return [...this.vigias.entries()]
      .filter(([, v]) => v.vigia.rodando)
      .map(([id]) => id);
  }

  sync(caixaId: number): Promise<void> {
    const anterior = this.filas.get(caixaId) ?? Promise.resolve();
    const p = anterior.then(() => this.sincronizar(caixaId)).catch((e) => {
      console.error(`[vigia] sync da caixa ${caixaId}:`, codigo(e));
    });
    this.filas.set(caixaId, p);
    p.finally(() => {
      if (this.filas.get(caixaId) === p) this.filas.delete(caixaId);
    });
    return p;
  }

  private async sincronizar(id: number): Promise<void> {
    if (this.parado) return;
    const [c] = await this.d.sql<
      { estado: string; senha_cifrada: string }[]
    >`SELECT estado, senha_cifrada FROM correio.caixas WHERE id = ${id}`;
    const deveVigiar = !!c && c.estado !== "precisa_senha";
    const atual = this.vigias.get(id);
    if (
      atual &&
      (!deveVigiar || !atual.vigia.rodando ||
        atual.senhaCifrada !== c.senha_cifrada)
    ) {
      this.vigias.delete(id);
      await atual.vigia.parar();
    }
    if (deveVigiar && !this.vigias.has(id) && !this.parado) {
      const vigia = new VigiaCaixa(id, this.d);
      this.vigias.set(id, { vigia, senhaCifrada: c.senha_cifrada });
      vigia.iniciar();
    }
  }

  async stop(): Promise<void> {
    this.parado = true;
    await Promise.all([...this.filas.values()]);
    const todos = [...this.vigias.values()];
    this.vigias.clear();
    await Promise.all(todos.map((v) => v.vigia.parar()));
  }
}
