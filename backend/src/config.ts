import { parsearContasResend, type ResendConfig } from "./mail/resend.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  databaseUrl: string;
  /** Opcional: sem ela o classificador de suspeita fica desligado. */
  openrouterKey?: string;
  masterKey: Uint8Array;
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  rpId: string;
  origin: string;
  inviteCode: string;
  /** Host público do Correio (link de primeiro acesso, padrão do RP ID). */
  host: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** false aceita certificado de outro nome (poste.io por hostname interno). */
  mailTlsVerify: boolean;
  /**
   * true (padrão): IMAP com TLS implícito; SMTP com TLS implícito na 465 e
   * STARTTLS obrigatório nas demais. false: sem TLS (só testes/dev, ex.:
   * GreenMail nas portas 3143/3025).
   */
  mailSecure: boolean;
  /** ManageSieve (RFC 5804): SIEVE_HOST (padrão IMAP_HOST) e SIEVE_PORT (4190). */
  sieveHost: string;
  sievePort: number;
  /**
   * Contas Resend por domínio (RESEND_CONTA_1..5). Ausente: todo envio sai
   * pelo poste.io. O recebimento (IMAP) é sempre pelo poste.io.
   */
  resend?: ResendConfig;
}

export const CORREIO_HOST_PADRAO = "correio.judinfo.com.br";
export const IMAP_HOST_PADRAO = "email.judinfo.com.br";

const REQUIRED = {
  databaseUrl: "DATABASE_URL",
  vapidPublic: "VAPID_PUBLIC_KEY",
  vapidPrivate: "VAPID_PRIVATE_KEY",
  vapidSubject: "VAPID_SUBJECT",
  rpId: "WEBAUTHN_RP_ID",
  origin: "WEBAUTHN_ORIGIN",
  inviteCode: "CORREIO_INVITE_CODE",
} as const;

type Get = (k: string) => string | undefined;

function porta(get: Get, nome: string, padrao: number): number {
  const v = get(nome);
  if (v === undefined) return padrao;
  if (!/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535) {
    throw new ConfigError(`${nome} deve ser uma porta entre 1 e 65535`);
  }
  return Number(v);
}

function booleano(get: Get, nome: string, padrao: boolean): boolean {
  const v = get(nome)?.toLowerCase();
  if (v === undefined) return padrao;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ConfigError(`${nome} deve ser true ou false`);
}

export function loadConfig(
  env: Record<string, string | undefined>,
  log: (m: string) => void = console.error,
): Config {
  const get: Get = (k) => (env[k]?.trim() ? env[k]!.trim() : undefined);
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const [field, name] of Object.entries(REQUIRED)) {
    const v = get(name);
    if (v === undefined) missing.push(name);
    else out[field] = v;
  }
  const mk = get("CORREIO_MASTER_KEY");
  if (mk === undefined) missing.push("CORREIO_MASTER_KEY");
  if (missing.length) {
    throw new ConfigError(
      `Variáveis de ambiente faltando: ${missing.join(", ")}`,
    );
  }
  let masterKey: Uint8Array;
  try {
    masterKey = Uint8Array.from(atob(mk!), (c) => c.charCodeAt(0));
  } catch {
    throw new ConfigError("CORREIO_MASTER_KEY não é base64 válido");
  }
  if (masterKey.length !== 32) {
    throw new ConfigError(
      `CORREIO_MASTER_KEY deve ter 32 bytes (base64); tem ${masterKey.length}`,
    );
  }
  const imapHost = get("IMAP_HOST") ?? IMAP_HOST_PADRAO;
  return {
    ...(out as Pick<Config, keyof typeof REQUIRED>),
    masterKey,
    openrouterKey: get("OPENROUTER_API_KEY"),
    host: get("CORREIO_HOST") ?? CORREIO_HOST_PADRAO,
    imapHost,
    imapPort: porta(get, "IMAP_PORT", 993),
    smtpHost: get("SMTP_HOST") ?? imapHost,
    smtpPort: porta(get, "SMTP_PORT", 587),
    mailTlsVerify: booleano(get, "MAIL_TLS_VERIFY", true),
    mailSecure: booleano(get, "MAIL_SECURE", true),
    sieveHost: get("SIEVE_HOST") ?? imapHost,
    sievePort: porta(get, "SIEVE_PORT", 4190),
    resend: parsearContasResend(get, log),
  };
}
