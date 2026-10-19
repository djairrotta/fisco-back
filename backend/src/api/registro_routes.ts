// GET /api/registro?nivel=&area=&caixa=&desde=&limite= — exige sessão
// (aplicada em criarApp). Mais recentes primeiro, no máximo 200.
import { Hono } from "@hono/hono";
import type { Sql } from "../db/client.ts";
import {
  type AreaRegistro,
  AREAS,
  type FiltroRegistro,
  LIMITE_MAX,
  listarRegistro,
  NIVEIS,
  type NivelRegistro,
} from "../db/registro.ts";

export interface RegistroDeps {
  sql: Sql;
}

export function rotasRegistro(d: RegistroDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const f: FiltroRegistro = {};

    const nivel = c.req.query("nivel");
    if (nivel) {
      if (!NIVEIS.includes(nivel as NivelRegistro)) {
        return c.json({ erro: "Nível inválido" }, 400);
      }
      f.nivel = nivel as NivelRegistro;
    }

    const area = c.req.query("area");
    if (area) {
      if (!AREAS.includes(area as AreaRegistro)) {
        return c.json({ erro: "Área inválida" }, 400);
      }
      f.area = area as AreaRegistro;
    }

    const caixa = c.req.query("caixa");
    if (caixa) {
      if (!/^\d{1,9}$/.test(caixa)) {
        return c.json({ erro: "Caixa inválida" }, 400);
      }
      f.caixa = Number(caixa);
    }

    const desde = c.req.query("desde");
    if (desde) {
      const d2 = new Date(desde);
      if (isNaN(d2.getTime())) return c.json({ erro: "Data inválida" }, 400);
      f.desde = d2;
    }

    const limite = c.req.query("limite");
    if (limite) {
      if (!/^\d{1,4}$/.test(limite)) {
        return c.json({ erro: "Limite inválido" }, 400);
      }
      f.limite = Math.min(Number(limite), LIMITE_MAX);
    }

    return c.json({ registro: await listarRegistro(d.sql, f) });
  });

  return app;
}
