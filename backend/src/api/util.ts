import type { Context, MiddlewareHandler } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import type { z } from "zod";

/** Limite padrão de corpo JSON (rotas de upload definem o seu). */
export const LIMITE_JSON = 64 * 1024;

export function limiteCorpo(
  maxSize = LIMITE_JSON,
  mensagem = "Corpo grande demais",
): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json({ erro: mensagem }, 413),
  });
}

/** Lê e valida o corpo JSON; corpo vazio vale `{}`. */
export async function corpo<T>(
  c: Context,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<{ ok: true; v: T } | { ok: false; r: Response }> {
  let bruto: unknown = {};
  const t = await c.req.text();
  if (t.trim()) {
    try {
      bruto = JSON.parse(t);
    } catch {
      return { ok: false, r: c.json({ erro: "JSON inválido" }, 400) };
    }
  }
  const p = schema.safeParse(bruto);
  if (!p.success) {
    return {
      ok: false,
      r: c.json({ erro: "Dados inválidos", detalhes: p.error.issues }, 400),
    };
  }
  return { ok: true, v: p.data };
}
