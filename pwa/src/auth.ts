import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

/** Login com passkey existente. O id do desafio viaja só no cookie HttpOnly vigia_c. */
export async function entrar(): Promise<void> {
  const optionsJSON = await api.post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/auth/login/opcoes",
    {},
  );
  const credencial = await startAuthentication({ optionsJSON });
  await api.post("/api/auth/login", credencial);
}

/** Cadastra este dispositivo (Face ID/Touch ID) a partir de um convite. */
export async function cadastrarPasskey(convite: string): Promise<void> {
  const optionsJSON = await api.post<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
    "/api/auth/registro/opcoes",
    { convite },
  );
  const credencial = await startRegistration({ optionsJSON });
  await api.post("/api/auth/registro", credencial);
}

export async function sair(): Promise<void> {
  await api.post("/api/auth/sair", {});
}
