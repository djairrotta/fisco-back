// Conexões IMAP (imapflow) e SMTP (nodemailer) de uma caixa. Base para
// leitura, envio e vigia de caixa de entrada (tarefas 3–5).
//
// Regras: nunca registrar credenciais; erros viram mensagens curtas em pt-BR
// (resumirErroMail); falha de login vira FalhaAutenticacao para a caixa ir a
// `precisa_senha` e parar de tentar.
import { ImapFlow, type ImapFlowOptions } from "imapflow";
// @ts-types="@types/nodemailer"
import nodemailer, { type Transporter } from "nodemailer";
// @ts-types="@types/nodemailer/lib/smtp-transport/index.d.ts"
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { Config } from "../config.ts";
import {
  alvoSmtp,
  type ResendConfig,
  resolverRemetente,
  type RotaEnvio,
} from "./resend.ts";

export type ConfigMail = Pick<
  Config,
  | "imapHost"
  | "imapPort"
  | "smtpHost"
  | "smtpPort"
  | "mailTlsVerify"
  | "mailSecure"
>;

/** O login no poste.io é o endereço completo. */
export interface CaixaLogin {
  endereco: string;
}

export interface ResultadoTeste {
  imap: boolean;
  smtp: boolean;
  /** Resumo pt-BR, sem segredo: "IMAP: …; SMTP: …". */
  erro?: string;
  /** Presente (true) quando IMAP ou SMTP recusou usuário/senha. */
  falhaAutenticacao?: true;
  /** Caminho de envio resolvido pelo domínio: "poste.io" ou "Resend re_7v…MPr". */
  envioVia?: string;
}

export type TestarCaixa = (
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
  opc?: { timeoutMs?: number; resend?: ResendConfig; rota?: RotaEnvio },
) => Promise<ResultadoTeste>;

export type SmtpTransporter = Transporter<SMTPTransport.SentMessageInfo>;

/** Login recusado pelo servidor (senha errada, conta bloqueada…). */
export class FalhaAutenticacao extends Error {
  constructor(message = "usuário ou senha recusados") {
    super(message);
    this.name = "FalhaAutenticacao";
  }
}

const TIMEOUT_PADRAO = 20_000;

export function opcoesImap(
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
  /** Se dado, limita também o socket (testes de conexão não travam no LOGIN). */
  timeoutMs?: number,
): ImapFlowOptions {
  return {
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: cfg.mailSecure,
    auth: { user: caixa.endereco, pass: senha },
    tls: { rejectUnauthorized: cfg.mailTlsVerify },
    logger: false,
    connectionTimeout: timeoutMs ?? TIMEOUT_PADRAO,
    greetingTimeout: timeoutMs ?? TIMEOUT_PADRAO,
    // sem timeout explícito: conexão longa (IDLE) precisa de socket folgado
    socketTimeout: timeoutMs ?? 5 * 60_000,
  };
}

export function opcoesSmtp(
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
  timeoutMs?: number,
): SMTPTransport.Options {
  const implicito = cfg.mailSecure && cfg.smtpPort === 465;
  return {
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: implicito,
    requireTLS: cfg.mailSecure && !implicito,
    ignoreTLS: !cfg.mailSecure,
    auth: { user: caixa.endereco, pass: senha },
    tls: { rejectUnauthorized: cfg.mailTlsVerify },
    connectionTimeout: timeoutMs ?? TIMEOUT_PADRAO,
    greetingTimeout: timeoutMs ?? TIMEOUT_PADRAO,
    socketTimeout: timeoutMs ?? 60_000,
    logger: false,
    debug: false,
  };
}

/** Códigos IMAP (RFC 5530) de recusa definitiva de credenciais. */
const CODIGOS_RECUSA_IMAP = new Set([
  "AUTHENTICATIONFAILED",
  "AUTHORIZATIONFAILED",
]);

/**
 * true só para recusa REAL de credenciais — o que leva a caixa a
 * `precisa_senha` e encerra as tentativas:
 * - IMAP: LOGIN/AUTHENTICATE respondido com NO pelo servidor (imapflow marca
 *   `authenticationFailed`, com o texto da resposta). Com código de resposta,
 *   só [AUTHENTICATIONFAILED]/[AUTHORIZATIONFAILED]; [UNAVAILABLE], [LIMIT]
 *   etc. são temporários. Conexão que cai durante o LOGIN (sem resposta, ou
 *   com `code` de rede) não conta — o imapflow também a marca como
 *   authenticationFailed;
 * - SMTP: EAUTH com resposta 535 (454 temporário e "Missing credentials"
 *   não contam).
 */
export function ehFalhaAutenticacao(e: unknown): boolean {
  if (e instanceof FalhaAutenticacao) return true;
  const x = e as
    | {
      authenticationFailed?: boolean;
      code?: string;
      serverResponseCode?: string;
      response?: unknown;
      responseCode?: number;
    }
    | null;
  if (!x) return false;
  if (x.code === "EAUTH") return x.responseCode === 535;
  if (x.authenticationFailed !== true) return false;
  if (x.code) return false; // erro de rede/protocolo no meio do LOGIN
  if (typeof x.response !== "string" || !x.response.trim()) return false;
  const cod = x.serverResponseCode?.toUpperCase();
  return cod === undefined || CODIGOS_RECUSA_IMAP.has(cod);
}

const CODIGOS_TLS =
  /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_CERT|HOSTNAME_MISMATCH)/;

/**
 * Mensagem curta em pt-BR. Nunca devolve o texto bruto do erro (pode ecoar
 * comandos do protocolo); só classifica por código.
 */
export function resumirErroMail(e: unknown): string {
  if (ehFalhaAutenticacao(e)) return "usuário ou senha recusados";
  const x = e as { code?: string; message?: string } | null;
  const code = String(x?.code ?? "");
  const msg = String(x?.message ?? "").toLowerCase();
  // nodemailer embrulha erros de socket em code=ESOCKET; o código original
  // fica no início da mensagem ("connect ECONNREFUSED …")
  const tem = (c: string) => code === c || msg.includes(c.toLowerCase());
  if (tem("ECONNREFUSED")) return "servidor recusou a conexão";
  if (tem("ENOTFOUND") || tem("EAI_AGAIN")) {
    return "servidor não encontrado";
  }
  if (
    code === "ETIMEDOUT" || code === "ETIMEOUT" || code === "CONNECT_TIMEOUT" ||
    code === "GREETING_TIMEOUT" || msg.includes("timeout") ||
    msg.includes("timed out")
  ) {
    return "tempo esgotado";
  }
  if (
    CODIGOS_TLS.test(code) || msg.includes("certificate") ||
    msg.includes("self-signed") || msg.includes("self signed")
  ) {
    return "certificado TLS do servidor não confere";
  }
  return "falha na conexão";
}

/**
 * Conecta e autentica no IMAP. Lança FalhaAutenticacao em senha recusada;
 * outros erros seguem como vieram (use resumirErroMail para exibir).
 * Quem chama deve fazer `logout()` (ou `close()`).
 */
export async function abrirImap(
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
  opc: { timeoutMs?: number } = {},
): Promise<ImapFlow> {
  const c = new ImapFlow(opcoesImap(cfg, caixa, senha, opc.timeoutMs));
  // sem ouvinte, um erro de socket vira exceção não tratada no processo
  c.on("error", () => {});
  try {
    await c.connect();
  } catch (e) {
    try {
      c.close();
    } catch { /* já fechado */ }
    if (ehFalhaAutenticacao(e)) throw new FalhaAutenticacao();
    throw e;
  }
  return c;
}

/** Transporter SMTP da caixa (não conecta até verify/sendMail). */
export function abrirSmtp(
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
  opc: { timeoutMs?: number } = {},
): SmtpTransporter {
  return nodemailer.createTransport(
    opcoesSmtp(cfg, caixa, senha, opc.timeoutMs),
  );
}

/**
 * Login IMAP (sempre poste.io) e SMTP (pelo caminho resolvido: Resend quando o
 * domínio da caixa estiver mapeado, senão poste.io), só `verify()`, em
 * paralelo. `envioVia` diz qual caminho foi verificado (chave Resend mascarada).
 */
export const testarCaixa: TestarCaixa = async (
  cfg,
  caixa,
  senha,
  { timeoutMs = TIMEOUT_PADRAO, resend, rota } = {},
) => {
  const opc = { timeoutMs };
  const alvo = alvoSmtp(
    rota ?? resolverRemetente(caixa.endereco, resend),
    cfg,
    caixa.endereco,
    senha,
  );
  const imap = (async () => {
    const c = await abrirImap(cfg, caixa, senha, opc);
    await c.logout().catch(() => c.close());
  })();
  const smtp = (async () => {
    const t = abrirSmtp(alvo.cfg, { endereco: alvo.usuario }, alvo.senha, opc);
    try {
      await t.verify();
    } finally {
      t.close();
    }
  })();
  const [ri, rs] = await Promise.allSettled([imap, smtp]);
  const r: ResultadoTeste = {
    imap: ri.status === "fulfilled",
    smtp: rs.status === "fulfilled",
    envioVia: alvo.descricao,
  };
  const erros: string[] = [];
  if (ri.status === "rejected") {
    erros.push(`IMAP: ${resumirErroMail(ri.reason)}`);
  }
  if (rs.status === "rejected") {
    erros.push(`SMTP: ${resumirErroMail(rs.reason)}`);
  }
  if (erros.length) r.erro = erros.join("; ");
  if (
    (ri.status === "rejected" && ehFalhaAutenticacao(ri.reason)) ||
    (rs.status === "rejected" && ehFalhaAutenticacao(rs.reason))
  ) {
    r.falhaAutenticacao = true;
  }
  return r;
};
