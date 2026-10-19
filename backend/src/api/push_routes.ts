import { Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { corpo, limiteCorpo } from "./util.ts";

/** Serviços de push aceitos (FCM, Apple, Mozilla, Windows). */
const HOSTS_PUSH = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^web\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function endpointPushPermitido(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.port === "" &&
      HOSTS_PUSH.some((r) => r.test(url.hostname.toLowerCase()));
  } catch {
    return false;
  }
}

const Inscricao = z.object({
  endpoint: z.string().url().max(2000).refine(
    endpointPushPermitido,
    "Serviço de push não reconhecido",
  ),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

const Cancelamento = z.object({
  endpoint: z.string().min(1).max(2000),
});

/** /api/push/* — exige sessão (aplicada em criarApp). */
export function rotasPush(sql: Sql, vapidPublic: string): Hono {
  const app = new Hono();
  app.use("*", limiteCorpo());

  app.get("/chave-publica", (c) => c.json({ chave: vapidPublic }));

  app.post("/inscrever", async (c) => {
    const b = await corpo(c, Inscricao);
    if (!b.ok) return b.r;
    await sql`INSERT INTO correio.push_inscricoes (endpoint, chaves)
      VALUES (${b.v.endpoint}, ${sql.json(b.v.keys)})
      ON CONFLICT (endpoint) DO UPDATE SET chaves = EXCLUDED.chaves`;
    return c.json({ ok: true });
  });

  app.post("/cancelar", async (c) => {
    const b = await corpo(c, Cancelamento);
    if (!b.ok) return b.r;
    await sql`DELETE FROM correio.push_inscricoes WHERE endpoint = ${b.v.endpoint}`;
    return c.json({ ok: true });
  });

  return app;
}
