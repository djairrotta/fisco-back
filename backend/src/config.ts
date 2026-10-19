export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  databaseUrl: string;
  cfApiToken: string;
  cfAccountId: string;
  openrouterKey: string;
  masterKey: Uint8Array;
  vapidPublic: string;
  vapidPrivate: string;
  vapidSubject: string;
  openwaUrl?: string;
  openwaApiKey?: string;
  adminPhone?: string;
  rpId: string;
  origin: string;
  inviteCode: string;
  /** Host do próprio Vigia: fica fora da regra geo (protegido por Access + passkey). */
  vigiaHost: string;
  /** Monitor de apps do EasyPanel: só com EASYPANEL_URL e EASYPANEL_TOKEN. */
  easypanel: { url: string; token: string } | null;
}

export const VIGIA_HOST_PADRAO = "vigia.judinfo.com.br";

const REQUIRED = {
  databaseUrl: "DATABASE_URL",
  cfApiToken: "CF_API_TOKEN",
  cfAccountId: "CF_ACCOUNT_ID",
  openrouterKey: "OPENROUTER_API_KEY",
  vapidPublic: "VAPID_PUBLIC_KEY",
  vapidPrivate: "VAPID_PRIVATE_KEY",
  vapidSubject: "VAPID_SUBJECT",
  rpId: "WEBAUTHN_RP_ID",
  origin: "WEBAUTHN_ORIGIN",
  inviteCode: "VIGIA_INVITE_CODE",
} as const;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const get = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);
  const missing: string[] = [];
  const out: Record<string, string> = {};
  for (const [field, name] of Object.entries(REQUIRED)) {
    const v = get(name);
    if (v === undefined) missing.push(name);
    else out[field] = v;
  }
  const mk = get("VIGIA_MASTER_KEY");
  if (mk === undefined) missing.push("VIGIA_MASTER_KEY");
  if (missing.length) {
    throw new ConfigError(
      `Variáveis de ambiente faltando: ${missing.join(", ")}`,
    );
  }
  let masterKey: Uint8Array;
  try {
    masterKey = Uint8Array.from(atob(mk!), (c) => c.charCodeAt(0));
  } catch {
    throw new ConfigError("VIGIA_MASTER_KEY não é base64 válido");
  }
  if (masterKey.length !== 32) {
    throw new ConfigError(
      `VIGIA_MASTER_KEY deve ter 32 bytes (base64); tem ${masterKey.length}`,
    );
  }
  const epUrl = get("EASYPANEL_URL");
  const epToken = get("EASYPANEL_TOKEN");
  if (epUrl && epToken && !/^https?:\/\/[^/\s]+/i.test(epUrl)) {
    throw new ConfigError(
      "EASYPANEL_URL deve começar com https:// (ex.: https://painel.exemplo.com.br)",
    );
  }
  return {
    ...(out as Omit<
      Config,
      | "masterKey"
      | "openwaUrl"
      | "openwaApiKey"
      | "adminPhone"
      | "vigiaHost"
      | "easypanel"
    >),
    easypanel: epUrl && epToken ? { url: epUrl, token: epToken } : null,
    vigiaHost: get("VIGIA_HOST") ?? VIGIA_HOST_PADRAO,
    masterKey,
    openwaUrl: get("OPENWA_URL"),
    openwaApiKey: get("OPENWA_API_KEY"),
    adminPhone: get("ADMIN_PHONE"),
  };
}
