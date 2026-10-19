import { Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import { corpo, limiteCorpo } from "./util.ts";

const TIPOS = ["recebido", "enviado", "falha"] as const;
type Tipo = typeof TIPOS[number];
type Mapa = Record<Tipo, boolean>;

export interface ConfigDeps {
  sql: Sql;
  /** OPENROUTER_API_KEY presente (sem ela o classificador nunca roda). */
  iaDisponivel: boolean;
}

const Notif = z.object({
  caixa: z.number().int().positive().nullable(),
  tipo: z.enum(TIPOS),
  ativo: z.boolean(),
}).strict();

/** Slug OpenRouter: "autor/modelo", com sufixo opcional (":free"). */
export const SLUG_MODELO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

const Ia = z.object({
  modelo: z.string().trim().min(3).max(200).regex(
    SLUG_MODELO,
    "Use o formato autor/modelo",
  ).optional(),
  ativo: z.boolean().optional(),
}).strict();

const IdCaixa = z.coerce.number().int().positive().max(2147483647);

async function auditarSeguro(
  sql: Sql,
  acao: string,
  detalhes: Record<string, unknown>,
) {
  try {
    await auditar(sql, "usuario", acao, null, detalhes);
  } catch (e) {
    console.error(`[config] falha ao auditar ${acao}:`, (e as Error)?.name);
  }
}

/**
 * /api/config/* — exige sessão (aplicada em criarApp).
 * - notificacoes: linha global (caixa_id NULL) e sobreposição por caixa;
 * - ia: modelo e liga/desliga do classificador;
 * - passkeys: lista (só leitura; nova passkey via /api/auth/registro com sessão).
 */
export function rotasConfig(d: ConfigDeps): Hono {
  const { sql } = d;
  const app = new Hono();
  app.use("*", limiteCorpo());

  async function mapa(caixa: number | null): Promise<Partial<Mapa>> {
    const rows = caixa === null
      ? await sql`SELECT tipo, ativo FROM correio.config_notificacao
          WHERE caixa_id IS NULL`
      : await sql`SELECT tipo, ativo FROM correio.config_notificacao
          WHERE caixa_id = ${caixa}`;
    const m: Partial<Mapa> = {};
    for (const r of rows) m[r.tipo as Tipo] = r.ativo === true;
    return m;
  }

  // GET ?caixa=ID → {global, caixa (efetivo: sobreposição da caixa ou global) | null}
  app.get("/notificacoes", async (c) => {
    const g = await mapa(null);
    const global = Object.fromEntries(
      TIPOS.map((t) => [t, g[t] ?? true]),
    ) as Mapa;
    const q = c.req.query("caixa");
    if (q === undefined) return c.json({ global, caixa: null });
    const id = IdCaixa.safeParse(q);
    if (!id.success) return c.json({ erro: "Caixa inválida" }, 400);
    const [ex] = await sql`SELECT 1 FROM correio.caixas WHERE id = ${id.data}`;
    if (!ex) return c.json({ erro: "Caixa não encontrada" }, 404);
    const p = await mapa(id.data);
    const caixa = Object.fromEntries(
      TIPOS.map((t) => [t, p[t] ?? global[t]]),
    ) as Mapa;
    return c.json({ global, caixa });
  });

  app.put("/notificacoes", async (c) => {
    const b = await corpo(c, Notif);
    if (!b.ok) return b.r;
    const { caixa, tipo, ativo } = b.v;
    if (caixa === null) {
      await sql`INSERT INTO correio.config_notificacao (caixa_id, tipo, ativo)
        VALUES (NULL, ${tipo}, ${ativo})
        ON CONFLICT (tipo) WHERE caixa_id IS NULL DO UPDATE SET ativo = EXCLUDED.ativo`;
    } else {
      const [ex] = await sql`SELECT 1 FROM correio.caixas WHERE id = ${caixa}`;
      if (!ex) return c.json({ erro: "Caixa não encontrada" }, 404);
      await sql`INSERT INTO correio.config_notificacao (caixa_id, tipo, ativo)
        VALUES (${caixa}, ${tipo}, ${ativo})
        ON CONFLICT (caixa_id, tipo) WHERE caixa_id IS NOT NULL
        DO UPDATE SET ativo = EXCLUDED.ativo`;
    }
    return c.json({ ok: true, caixa, tipo, ativo });
  });

  async function lerIa() {
    const [r] = await sql`SELECT modelo, ativo, timeout_s FROM correio.config_ia
      WHERE papel = 'classificador'`;
    return {
      modelo: String(r?.modelo ?? ""),
      ativo: r?.ativo === true,
      timeoutS: Number(r?.timeout_s ?? 20),
      chaveConfigurada: d.iaDisponivel,
    };
  }

  app.get("/ia", async (c) => c.json(await lerIa()));

  app.put("/ia", async (c) => {
    const b = await corpo(c, Ia);
    if (!b.ok) {
      const issue = (await b.r.clone().json())?.detalhes?.[0];
      if (issue?.path?.[0] === "modelo") {
        return c.json({
          erro:
            "Modelo inválido: use o formato autor/modelo (ex.: typesafe/jev-1.13)",
        }, 400);
      }
      return b.r;
    }
    const { modelo, ativo } = b.v;
    await sql`UPDATE correio.config_ia SET
        modelo = COALESCE(${modelo ?? null}::text, modelo),
        ativo = COALESCE(${ativo ?? null}::boolean, ativo)
      WHERE papel = 'classificador'`;
    await auditarSeguro(sql, "config_ia", { modelo, ativo });
    return c.json(await lerIa());
  });

  app.get("/passkeys", async (c) => {
    const rows = await sql`SELECT id, credential_id, transports, criado
      FROM correio.passkeys ORDER BY id`;
    return c.json({
      passkeys: rows.map((r) => ({
        id: r.id as number,
        // só um prefixo: identifica sem expor o id inteiro
        credencial: String(r.credential_id).slice(0, 10),
        transportes: (r.transports ?? []) as string[],
        criado: (r.criado as Date).toISOString(),
      })),
    });
  });

  return app;
}
