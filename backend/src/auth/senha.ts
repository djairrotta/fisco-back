// Login por usuário e senha (acesso de recuperação/primeiro acesso, além da passkey).
// Desligado por padrão: só existe se CORREIO_LOGIN_USUARIO e CORREIO_LOGIN_SENHA_HASH
// estiverem no ambiente. Guardamos só o hash PBKDF2-SHA256 (600 mil iterações),
// no formato  pbkdf2$<iteracoes>$<sal base64url>$<hash base64url>.
// Para desligar o login por senha, basta apagar as duas variáveis e fazer Deploy.
import { base64url, iguaisConstante } from "./session.ts";

const ITERACOES_PADRAO = 600_000;

function deBase64url(s: string): Uint8Array {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function derivar(senha: string, sal: Uint8Array, iteracoes: number): Promise<Uint8Array> {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal as BufferSource, iterations: iteracoes },
    chave,
    256,
  );
  return new Uint8Array(bits);
}

export async function gerarHashSenha(senha: string, iteracoes = ITERACOES_PADRAO): Promise<string> {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iteracoes}$${base64url(sal)}$${base64url(await derivar(senha, sal, iteracoes))}`;
}

export async function conferirSenha(senha: string, hash: string): Promise<boolean> {
  const p = hash.split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") return false;
  const iteracoes = Number(p[1]);
  if (!Number.isInteger(iteracoes) || iteracoes < 100_000 || iteracoes > 5_000_000) return false;
  const calc = base64url(await derivar(senha, deBase64url(p[2]), iteracoes));
  return await iguaisConstante(calc, p[3]);
}

export interface ConfigSenha {
  usuario: string;
  hash: string;
}

export function configSenha(): ConfigSenha | null {
  const usuario = (Deno.env.get("CORREIO_LOGIN_USUARIO") ?? "").trim();
  const hash = (Deno.env.get("CORREIO_LOGIN_SENHA_HASH") ?? "").trim();
  return usuario && hash.startsWith("pbkdf2$") ? { usuario, hash } : null;
}

/** true se usuário e senha batem. Sempre roda o PBKDF2 (mesmo tempo com usuário errado). */
export async function loginSenhaValido(usuario: string, senha: string, cfg = configSenha()): Promise<boolean> {
  if (!cfg) return false;
  const senhaOk = await conferirSenha(senha, cfg.hash);
  const usuarioOk = await iguaisConstante(usuario.trim().toLowerCase(), cfg.usuario.toLowerCase());
  return senhaOk && usuarioOk;
}

if (import.meta.main) {
  // deno run src/auth/senha.ts '<senha>'  → imprime o hash para CORREIO_LOGIN_SENHA_HASH
  const s = Deno.args[0];
  if (!s || s.length < 12) {
    console.error("uso: deno run src/auth/senha.ts '<senha com 12+ caracteres>'");
    Deno.exit(1);
  }
  console.log(await gerarHashSenha(s));
}
