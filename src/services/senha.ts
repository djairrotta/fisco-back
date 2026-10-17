/**
 * Hash de senha com scrypt nativo.
 *
 * Nao usamos bcrypt/argon2 de npm de proposito: o caminho mais sensivel
 * do sistema nao ganha dependencia de terceiro. scrypt vem no Node, e
 * resistente a hardware dedicado e tem parametros explicitos aqui.
 *
 * Formato: scrypt$<N>$<sal_hex>$<hash_hex>, para poder subir o custo no
 * futuro sem invalidar as senhas ja gravadas.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derivar = promisify(scrypt) as (
  s: string | Buffer, sal: string | Buffer, tam: number, op: object
) => Promise<Buffer>;

const N = 16384, r = 8, p = 1, TAM = 64;

export async function gerarHash(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const h = await derivar(senha.normalize("NFKC"), sal, TAM, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${sal.toString("hex")}$${h.toString("hex")}`;
}

export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const partes = (guardado || "").split("$");
  if (partes.length !== 4 || partes[0] !== "scrypt") return false;
  const custo = Number(partes[1]);
  if (!Number.isInteger(custo) || custo < 1024) return false;
  const sal = Buffer.from(partes[2], "hex");
  const esperado = Buffer.from(partes[3], "hex");
  const h = await derivar(senha.normalize("NFKC"), sal, esperado.length,
                          { N: custo, r, p, maxmem: 64 * 1024 * 1024 });
  // timingSafeEqual exige mesmo tamanho; o length ja veio do esperado.
  return h.length === esperado.length && timingSafeEqual(h, esperado);
}

/** Regra minima de senha. Comprimento manda mais que simbolo obrigatorio. */
export function senhaFraca(senha: string): string | null {
  if (senha.length < 10) return "A senha precisa de pelo menos 10 caracteres.";
  if (/^\d+$/.test(senha)) return "A senha não pode ser só números.";
  return null;
}
