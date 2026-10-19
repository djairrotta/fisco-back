// Resolução do caminho de envio por domínio do remetente.
//
// As CHAVES da Resend vivem SÓ em variáveis de ambiente (RESEND_CONTA_1..20),
// nunca no banco. O app gerencia apenas o mapeamento domínio→conta (slot).
// Quando o domínio da caixa remetente está mapeado para um slot que tem chave
// no ambiente, o envio sai pelo SMTP da Resend (smtp.resend.com:587 STARTTLS,
// usuário "resend", senha = chave daquele slot). Caso contrário, poste.io.
// Nunca registre a chave inteira.
import { ConfigError } from "../config.ts";
import type { ConfigMail } from "./conexao.ts";

/** SMTP da Resend (produção). */
export const RESEND_SMTP_HOST = "smtp.resend.com";
export const RESEND_SMTP_PORT = 587;
export const RESEND_SMTP_USUARIO = "resend";
/** Número máximo de contas/slots Resend. */
export const MAX_SLOTS = 20;

/** Uma conta Resend pronta para envio (resolvida por domínio). */
export interface ContaResend {
  /** API key (re_…); é a senha SMTP. Nunca logar inteira. */
  apikey: string;
  /** Usuário SMTP; "resend" em produção (sobrescrevível nos testes). */
  usuario: string;
  smtpHost: string;
  smtpPort: number;
  mailSecure: boolean;
  mailTlsVerify: boolean;
}

/** Um slot de conta Resend lido do ambiente (a chave fica aqui, não no banco). */
export interface SlotResend {
  /** 1..20. */
  slot: number;
  apikey: string;
  /** Rótulo opcional (RESEND_CONTA_<n>_NOME). */
  nome?: string;
  /** Domínios declarados inline (`| a,b`): só bootstrap/fallback. */
  dominiosInline: string[];
}

export interface ResendConfig {
  /** slot (1..20) → chave do ambiente. Só slots com chave presente. */
  slots: Map<number, SlotResend>;
  /** Nome de exibição padrão do From (RESEND_FROM_PADRAO), opcional. */
  fromPadrao?: string;
}

export type RotaEnvio =
  | { tipo: "poste" }
  | { tipo: "resend"; conta: ContaResend; mascara: string; slot?: number };

/** Parte após @, minúscula ("" se não houver). */
export function dominioDe(endereco: string): string {
  return (endereco.split("@")[1] ?? "").trim().toLowerCase();
}

/**
 * "re_7v…MPr": 5 primeiros caracteres, reticências e 3 últimos. Identifica a
 * conta sem revelar a chave. Chaves curtas caem num resumo seguro.
 */
export function mascararChave(apikey: string): string {
  const k = apikey.trim();
  if (k.length <= 9) return `${k.slice(0, 3)}…`;
  return `${k.slice(0, 5)}…${k.slice(-3)}`;
}

/** ContaResend (SMTP pronto) a partir da chave de um slot. */
export function contaDeSlot(apikey: string): ContaResend {
  return {
    apikey,
    usuario: RESEND_SMTP_USUARIO,
    smtpHost: RESEND_SMTP_HOST,
    smtpPort: RESEND_SMTP_PORT,
    mailSecure: true,
    mailTlsVerify: true,
  };
}

type Get = (k: string) => string | undefined;

/**
 * Lê RESEND_CONTA_1..20 (`re_<chave>`, opcionalmente `re_<chave> | dom1,dom2`),
 * RESEND_CONTA_<n>_NOME e RESEND_FROM_PADRAO. A chave tem de começar com `re_`.
 * O `| dominios` é só para bootstrap/fallback; o mapeamento do dia a dia é no
 * banco. undefined se nada foi configurado.
 */
export function parsearContasResend(
  get: Get,
  log: (m: string) => void = console.error,
): ResendConfig | undefined {
  const slots = new Map<number, SlotResend>();
  const vistos = new Set<string>();
  for (let n = 1; n <= MAX_SLOTS; n++) {
    const nome0 = `RESEND_CONTA_${n}`;
    const v = get(nome0);
    if (v === undefined) continue;
    const barra = v.indexOf("|");
    const apikey = (barra < 0 ? v : v.slice(0, barra)).trim();
    if (!apikey.startsWith("re_")) {
      throw new ConfigError(
        `${nome0}: a chave da Resend deve começar com "re_"`,
      );
    }
    const dominiosInline: string[] = [];
    if (barra >= 0) {
      for (const d of v.slice(barra + 1).split(",")) {
        const dom = d.trim().toLowerCase();
        if (!dom) continue;
        if (vistos.has(dom)) {
          log(
            `[config] RESEND: domínio "${dom}" aparece em mais de um slot inline; ` +
              `mantendo o primeiro`,
          );
          continue;
        }
        vistos.add(dom);
        dominiosInline.push(dom);
      }
    }
    const nome = get(`${nome0}_NOME`);
    slots.set(n, {
      slot: n,
      apikey,
      dominiosInline,
      ...(nome ? { nome } : {}),
    });
  }
  const fromPadrao = get("RESEND_FROM_PADRAO");
  if (!slots.size && !fromPadrao) return undefined;
  return { slots, ...(fromPadrao ? { fromPadrao } : {}) };
}

/**
 * Resolução SÓ pelo ambiente (fallback): domínio declarado inline em algum
 * slot → aquela conta; senão poste.io. O mapeamento do banco tem precedência
 * e é tratado em resend_contas.ts (resolverRemetenteDb).
 */
export function resolverRemetente(
  endereco: string,
  cfg: ResendConfig | undefined,
): RotaEnvio {
  const dom = dominioDe(endereco);
  if (cfg && dom) {
    for (const s of cfg.slots.values()) {
      if (s.dominiosInline.includes(dom)) {
        return {
          tipo: "resend",
          conta: contaDeSlot(s.apikey),
          mascara: mascararChave(s.apikey),
          slot: s.slot,
        };
      }
    }
  }
  return { tipo: "poste" };
}

/** Parâmetros concretos de SMTP (cfg/usuário/senha) para uma rota já resolvida. */
export interface AlvoSmtp {
  cfg: ConfigMail;
  usuario: string;
  senha: string;
  /** Resumo sem segredo: "poste.io" ou "Resend conta 2 re_7v…MPr". */
  descricao: string;
}

/**
 * Traduz a rota em cfg/usuário/senha para abrirSmtp/transmitirSmtp. Resend
 * sobrescreve só os campos de SMTP do cfg do poste; IMAP permanece (não é
 * usado no envio).
 */
export function alvoSmtp(
  rota: RotaEnvio,
  poste: ConfigMail,
  endereco: string,
  senha: string,
): AlvoSmtp {
  if (rota.tipo === "resend") {
    const { conta } = rota;
    const conta_ = rota.slot ? `conta ${rota.slot} ` : "";
    return {
      cfg: {
        ...poste,
        smtpHost: conta.smtpHost,
        smtpPort: conta.smtpPort,
        mailSecure: conta.mailSecure,
        mailTlsVerify: conta.mailTlsVerify,
      },
      usuario: conta.usuario,
      senha: conta.apikey,
      descricao: `Resend ${conta_}${rota.mascara}`,
    };
  }
  return { cfg: poste, usuario: endereco, senha, descricao: "poste.io" };
}
