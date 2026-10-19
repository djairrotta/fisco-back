import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { ApiError, api, limparDadosLocais } from "./api";

/** Login com passkey existente. O id do desafio viaja só no cookie HttpOnly correio_c. */
export async function entrar(): Promise<void> {
  const optionsJSON = await api.post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/auth/login/opcoes",
    {},
  );
  const credencial = await startAuthentication({ optionsJSON });
  await api.post("/api/auth/login", credencial);
}

/**
 * Cadastra este dispositivo (Face ID/Touch ID): com `convite` no primeiro
 * acesso, ou sem ele quando já há sessão (passkey adicional).
 */
export async function cadastrarPasskey(convite?: string): Promise<void> {
  const optionsJSON = await api.post<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/auth/registro/opcoes",
    convite ? { convite } : {},
  );
  const credencial = await startRegistration({ optionsJSON });
  await api.post("/api/auth/registro", credencial);
}

/** Sai e apaga os dados locais (rascunhos, endereços vistos), mesmo se o servidor falhar. */
export async function sair(): Promise<void> {
  try {
    await api.post("/api/auth/sair", {});
  } finally {
    limparDadosLocais();
  }
}

export interface EstadoAuth {
  host: string;
  origem: string;
}

export const estadoAuth = () => api.get<EstadoAuth>("/api/auth/estado");

/** Aviso quando o app foi aberto por um endereço diferente do esperado pelo servidor. */
export function avisoEndereco(esperado: EstadoAuth | null, hostAtual: string): string {
  if (!esperado?.host || esperado.host === hostAtual) return "";
  return `Abra pelo endereço ${esperado.origem || `https://${esperado.host}`}`;
}

/**
 * Mensagem pt-BR para qualquer falha de passkey — nunca falha muda.
 * Erros do servidor (ApiError) trazem o texto do backend; erros do
 * navegador (DOMException/WebAuthnError) viram uma explicação.
 */
export function explicarErroPasskey(e: unknown, esperado: EstadoAuth | null, hostAtual: string): string {
  if (e instanceof ApiError) return e.message;
  const x = e as { name?: string; code?: string; message?: string; cause?: { name?: string } } | null;
  const nome = x?.cause?.name ?? x?.name ?? "";
  const aviso = avisoEndereco(esperado, hostAtual);
  if (nome === "NotAllowedError") {
    return "Autenticação cancelada, expirada ou sem passkey para este endereço." + (aviso ? ` ${aviso}.` : "");
  }
  if (nome === "SecurityError" || x?.code === "ERROR_INVALID_DOMAIN" || x?.code === "ERROR_INVALID_RP_ID") {
    return `O navegador recusou a passkey neste endereço (${hostAtual}).` + (aviso ? ` ${aviso}.` : "");
  }
  if (nome === "InvalidStateError" || x?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return "Este dispositivo já tem uma passkey do Correio. Use “Entrar com passkey”.";
  }
  if (nome === "NotSupportedError") {
    return "Este navegador não suporta passkeys.";
  }
  const msg = x?.message?.trim();
  return msg ? `Falha na passkey: ${msg}` : "Não foi possível autenticar (erro desconhecido).";
}
