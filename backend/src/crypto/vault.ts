// Cofre AES-256-GCM. Formato: v1:<iv base64>:<ciphertext+tag base64>
// Síncrono por conveniência dos chamadores; usa node:crypto (disponível no Deno).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const enc64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const dec64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function checkKey(key: Uint8Array) {
  if (key.length !== 32) throw new Error("Chave do cofre deve ter 32 bytes");
}

export function encrypt(plain: string, key: Uint8Array): string {
  checkKey(key);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    c.update(plain, "utf8"),
    c.final(),
    c.getAuthTag(),
  ]);
  return `v1:${enc64(iv)}:${enc64(ct)}`;
}

export function decrypt(token: string, key: Uint8Array): string {
  checkKey(key);
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Token do cofre inválido");
  }
  const iv = dec64(parts[1]);
  const all = dec64(parts[2]);
  if (iv.length !== 12 || all.length < 16) {
    throw new Error("Token do cofre inválido");
  }
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(all.subarray(all.length - 16));
  return Buffer.concat([d.update(all.subarray(0, all.length - 16)), d.final()])
    .toString("utf8");
}
