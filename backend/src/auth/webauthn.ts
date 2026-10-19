import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Sql } from "../db/client.ts";
import {
  type Agora,
  base64url,
  criarSessao,
  iguaisConstante,
  NaoAutorizado,
  sha256Hex,
  validarSessao,
} from "./session.ts";

export { NaoAutorizado };

/**
 * A origem que o navegador assinou (clientDataJSON.origin) difere da
 * WEBAUTHN_ORIGIN configurada — o app foi aberto por outro endereço.
 */
export class OrigemDivergente extends NaoAutorizado {
  constructor(public recebida: string, public esperada: string) {
    super("origem divergente");
    this.name = "OrigemDivergente";
  }
}

/** Convite errado, ou já existe passkey (o convite só vale para a primeira). */
export class ConviteRecusado extends NaoAutorizado {
  constructor() {
    super("convite recusado");
    this.name = "ConviteRecusado";
  }
}

/** Origem dentro do clientDataJSON (base64url), ou null se ausente/ilegível. */
export function origemDoCliente(resp: unknown): string | null {
  const b64 = (resp as { response?: { clientDataJSON?: unknown } })?.response
    ?.clientDataJSON;
  if (typeof b64 !== "string" || b64.length > 8192) return null;
  try {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const o = JSON.parse(new TextDecoder().decode(bytes))?.origin;
    return typeof o === "string" ? o.slice(0, 300) : null;
  } catch {
    return null;
  }
}

function conferirOrigem(d: WebauthnDeps, resp: unknown) {
  const o = origemDoCliente(resp);
  if (o !== null && o !== d.cfg.origin) {
    throw new OrigemDivergente(o, d.cfg.origin);
  }
}

export const COOKIE_DESAFIO = "correio_c";
export const DESAFIO_TTL_MS = 5 * 60_000;
export const MAX_DESAFIOS = 1000;

interface Desafio {
  challenge: string;
  exp: number;
  tipo: "registro" | "login";
  /** registro adicional: SHA-256 do token da sessão que autorizou */
  sessaoHash?: string;
}

export interface WebauthnDeps {
  sql: Sql;
  cfg: { rpId: string; origin: string; inviteCode: string };
  agora: Agora;
  desafios: Map<string, Desafio>;
  verificarReg: typeof verifyRegistrationResponse;
  verificarAuth: typeof verifyAuthenticationResponse;
}

const desafiosPadrao = new Map<string, Desafio>();

export function depsPadrao(
  sql: Sql,
  cfg: WebauthnDeps["cfg"],
): WebauthnDeps {
  return {
    sql,
    cfg,
    agora: () => new Date(),
    desafios: desafiosPadrao,
    verificarReg: verifyRegistrationResponse,
    verificarAuth: verifyAuthenticationResponse,
  };
}

const USER_ID = new TextEncoder().encode("correio-admin");

const novoId = () => base64url(crypto.getRandomValues(new Uint8Array(24)));

function guardar(d: WebauthnDeps, v: Omit<Desafio, "exp">): string {
  const agora = d.agora().getTime();
  for (const [k, x] of d.desafios) if (x.exp <= agora) d.desafios.delete(k);
  if (d.desafios.size >= MAX_DESAFIOS) {
    throw new NaoAutorizado("muitas tentativas");
  }
  const id = novoId();
  d.desafios.set(id, { ...v, exp: agora + DESAFIO_TTL_MS });
  return id;
}

/** Uso único: remove sempre; devolve null se ausente, expirado ou de outro tipo. */
function consumir(d: WebauthnDeps, id: string, tipo: Desafio["tipo"]) {
  const v = d.desafios.get(id);
  d.desafios.delete(id);
  if (!v || v.exp <= d.agora().getTime() || v.tipo !== tipo) {
    throw new NaoAutorizado("desafio inválido ou expirado");
  }
  return v;
}

async function temPasskey(sql: Sql): Promise<boolean> {
  return (await sql`select 1 from correio.passkeys limit 1`).length > 0;
}

export async function opcoesRegistro(
  d: WebauthnDeps,
  auth: { convite?: string; sessaoToken?: string },
) {
  const comSessao = !!auth.sessaoToken &&
    await validarSessao(d.sql, auth.sessaoToken, d.agora);
  const existe = await temPasskey(d.sql);
  if (!comSessao) {
    const conviteOk = await iguaisConstante(
      auth.convite ?? "",
      d.cfg.inviteCode,
    );
    if (!conviteOk || existe) throw new ConviteRecusado();
  }
  const existentes = await d
    .sql`select credential_id, transports from correio.passkeys`;
  const opcoes = await generateRegistrationOptions({
    rpName: "Correio",
    rpID: d.cfg.rpId,
    userName: "admin",
    userID: USER_ID,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    excludeCredentials: existentes.map((r) => ({
      id: r.credential_id as string,
      transports: (r.transports ?? undefined) as
        | AuthenticatorTransportFuture[]
        | undefined,
    })),
  });
  const desafioId = guardar(d, {
    challenge: opcoes.challenge,
    tipo: "registro",
    sessaoHash: comSessao ? await sha256Hex(auth.sessaoToken!) : undefined,
  });
  return { opcoes, desafioId };
}

export async function verificarRegistro(
  d: WebauthnDeps,
  desafioId: string,
  resp: RegistrationResponseJSON,
) {
  const des = consumir(d, desafioId, "registro");
  conferirOrigem(d, resp);
  if (des.sessaoHash) {
    const ok = await d.sql`select 1 from correio.sessoes
      where token_hash = ${des.sessaoHash} and expira > ${d.agora()}`;
    if (ok.length === 0) throw new NaoAutorizado("sessão inválida");
  }
  let r;
  try {
    r = await d.verificarReg({
      response: resp,
      expectedChallenge: des.challenge,
      expectedOrigin: d.cfg.origin,
      expectedRPID: d.cfg.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new NaoAutorizado("registro inválido");
  }
  if (!r.verified || !r.registrationInfo) {
    throw new NaoAutorizado("registro inválido");
  }
  const c = r.registrationInfo.credential;
  try {
    await d.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('correio:passkey_primeiro'))`;
      if (!des.sessaoHash) {
        const ex = await tx`select 1 from correio.passkeys limit 1`;
        if (ex.length > 0) throw new NaoAutorizado();
      }
      await tx`insert into correio.passkeys (credential_id, public_key, counter, transports)
        values (${c.id}, ${c.publicKey}, ${c.counter}, ${
        c.transports ?? null
      })`;
    });
  } catch (e) {
    if (e instanceof NaoAutorizado) throw e;
    if ((e as { code?: string }).code === "23505") {
      throw new NaoAutorizado("credencial já registrada");
    }
    throw e;
  }
  return { ok: true };
}

export async function opcoesLogin(d: WebauthnDeps) {
  const opcoes = await generateAuthenticationOptions({
    rpID: d.cfg.rpId,
    userVerification: "required",
    allowCredentials: [],
  });
  const desafioId = guardar(d, { challenge: opcoes.challenge, tipo: "login" });
  return { opcoes, desafioId };
}

export async function verificarLogin(
  d: WebauthnDeps,
  desafioId: string,
  resp: AuthenticationResponseJSON,
  dispositivo = "desconhecido",
): Promise<{ token: string }> {
  const des = consumir(d, desafioId, "login");
  conferirOrigem(d, resp);
  const rows = await d
    .sql`select credential_id, public_key, counter::text as counter, transports
    from correio.passkeys where credential_id = ${resp.id}`;
  if (rows.length === 0) throw new NaoAutorizado("credencial desconhecida");
  const p = rows[0];
  const armazenado = Number(p.counter);
  let r;
  try {
    r = await d.verificarAuth({
      response: resp,
      expectedChallenge: des.challenge,
      expectedOrigin: d.cfg.origin,
      expectedRPID: d.cfg.rpId,
      requireUserVerification: true,
      credential: {
        id: p.credential_id as string,
        publicKey: new Uint8Array(p.public_key as Uint8Array),
        counter: armazenado,
        transports: (p.transports ?? undefined) as
          | AuthenticatorTransportFuture[]
          | undefined,
      },
    });
  } catch {
    throw new NaoAutorizado("login inválido");
  }
  if (!r.verified) throw new NaoAutorizado("login inválido");
  const novo = r.authenticationInfo.newCounter;
  if (armazenado > 0 && novo <= armazenado) {
    throw new NaoAutorizado("contador regrediu");
  }
  const up = await d.sql`update correio.passkeys set counter = ${novo}
    where credential_id = ${resp.id} and counter = ${armazenado} returning 1`;
  if (up.length === 0) throw new NaoAutorizado("contador alterado");
  return { token: await criarSessao(d.sql, dispositivo, d.agora) };
}
