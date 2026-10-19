// Conexões IMAP de curta duração para as rotas de leitura: uma conexão por
// requisição, serializada por um mutex por caixa (poste.io limita conexões
// simultâneas e senhas erradas repetidas bloqueiam a conta).
//
// Senha recusada → caixa vai a `precisa_senha` e o pool para de tentar até a
// senha ser trocada (PATCH /api/caixas/:id). Erros de rede não mudam o estado
// para precisa_senha; um login bem-sucedido tira a caixa de `erro`.
import type { ImapFlow } from "imapflow";
import type { Sql } from "../db/client.ts";
import {
  definirEstado,
  lerSenha,
  marcarPrecisaSenha,
  obterCaixa,
  SenhaIlegivel,
} from "../caixas/repo.ts";
import { abrirImap, type ConfigMail, ehFalhaAutenticacao } from "./conexao.ts";

export class CaixaNaoEncontrada extends Error {
  constructor() {
    super("Caixa não encontrada");
    this.name = "CaixaNaoEncontrada";
  }
}

export const MENSAGEM_SENHA_ILEGIVEL =
  "A senha guardada não pôde ser lida: senha precisa ser digitada de novo.";

export class CaixaPrecisaSenha extends Error {
  constructor(
    mensagem =
      "A senha desta caixa foi recusada pelo servidor. Atualize a senha nas configurações da caixa.",
  ) {
    super(mensagem);
    this.name = "CaixaPrecisaSenha";
  }
}

export interface CaixaConectada {
  id: number;
  endereco: string;
}

export interface Reserva {
  cliente: ImapFlow;
  caixa: CaixaConectada;
  /** Faz logout (ou fecha) e solta o mutex. Idempotente. */
  liberar(): Promise<void>;
}

export interface Pool {
  /** Abre, executa `fn`, faz logout e solta o mutex (mesmo em erro). */
  comImap<T>(
    caixaId: number,
    fn: (c: ImapFlow, caixa: CaixaConectada) => Promise<T>,
  ): Promise<T>;
  /** Para streaming: a conexão e o mutex ficam presos até `liberar()`. */
  reservar(caixaId: number): Promise<Reserva>;
}

export interface PoolDeps {
  sql: Sql;
  masterKey: Uint8Array;
  mail: ConfigMail;
  /** Injetável nos testes. */
  abrir?: typeof abrirImap;
  /** Conexão, saudação e inatividade do socket. Padrão 30 s. */
  timeoutMs?: number;
}

const LOGOUT_MS = 5_000;

export function criarPool(d: PoolDeps): Pool {
  const abrir = d.abrir ?? abrirImap;
  const timeoutMs = d.timeoutMs ?? 30_000;
  /** Fim da última operação enfileirada, por caixa. */
  const filas = new Map<number, Promise<void>>();

  async function travar(id: number): Promise<() => void> {
    const anterior = filas.get(id) ?? Promise.resolve();
    let soltar!: () => void;
    const minha = new Promise<void>((r) => soltar = r);
    const fim = anterior.then(() => minha);
    filas.set(id, fim);
    await anterior;
    return () => {
      soltar();
      if (filas.get(id) === fim) filas.delete(id);
    };
  }

  async function conectar(id: number): Promise<Reserva> {
    const caixa = await obterCaixa(d.sql, id);
    if (!caixa) throw new CaixaNaoEncontrada();
    if (caixa.estado === "precisa_senha") {
      throw new CaixaPrecisaSenha(
        caixa.estado_motivo ? MENSAGEM_SENHA_ILEGIVEL : undefined,
      );
    }
    let cred;
    try {
      cred = await lerSenha(d.sql, d.masterKey, id);
    } catch (e) {
      // chave mestra trocada: já ficou em precisa_senha com o motivo
      if (e instanceof SenhaIlegivel) {
        throw new CaixaPrecisaSenha(MENSAGEM_SENHA_ILEGIVEL);
      }
      throw e;
    }
    if (!cred) throw new CaixaNaoEncontrada();
    let cliente: ImapFlow;
    try {
      cliente = await abrir(d.mail, { endereco: cred.endereco }, cred.senha, {
        timeoutMs,
      });
    } catch (e) {
      if (ehFalhaAutenticacao(e)) {
        await marcarPrecisaSenha(d.sql, id, cred.senhaCifrada);
        throw new CaixaPrecisaSenha();
      }
      throw e;
    }
    if (caixa.estado === "erro") await definirEstado(d.sql, id, "ok");
    let liberada = false;
    return {
      cliente,
      caixa: { id, endereco: cred.endereco },
      liberar: async () => {
        if (liberada) return;
        liberada = true;
        await encerrar(cliente);
      },
    };
  }

  async function reservar(id: number): Promise<Reserva> {
    const soltar = await travar(id);
    let r: Reserva;
    try {
      r = await conectar(id);
    } catch (e) {
      soltar();
      throw e;
    }
    const liberar = r.liberar;
    let feito: Promise<void> | undefined;
    return {
      ...r,
      liberar: () => feito ??= liberar().finally(soltar),
    };
  }

  return {
    reservar,
    async comImap(id, fn) {
      const r = await reservar(id);
      try {
        return await fn(r.cliente, r.caixa);
      } finally {
        await r.liberar();
      }
    },
  };
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
