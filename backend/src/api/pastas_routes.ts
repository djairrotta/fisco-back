// /api/caixas/:id/pastas (listar com contagens, criar, renomear, excluir),
// /api/caixas/:id/favoritos (visão virtual) e /api/caixas/:id/busca.
import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import type { Pool } from "../mail/pool.ts";
import {
  criarPasta,
  excluirPasta,
  pastasComContagem,
  renomearPasta,
} from "../mail/pastas.ts";
import {
  buscar,
  favoritos,
  type FiltrosBusca,
  LIMITE_BUSCA,
} from "../mail/busca.ts";
import { corpo, limiteCorpo } from "./util.ts";
import { comCaixa, Invalido, pastaDe, pastaValida } from "./erros.ts";

export interface PastasDeps {
  sql: Sql;
  pool: Pool;
}

const NovaPasta = z.object({
  nome: z.string().min(1).max(200),
  pai: z.string().max(500).refine(pastaValida).nullable().optional(),
});
const Renomear = z.object({ nome: z.string().min(1).max(200) });

async function auditarPasta(
  sql: Sql,
  acao: string,
  endereco: string,
  detalhes: Record<string, unknown>,
) {
  try {
    await auditar(sql, "usuario", acao, endereco, detalhes);
  } catch (e) {
    console.error("[pastas] falha ao auditar:", (e as Error)?.name);
  }
}

// deno-lint-ignore no-control-regex
const CONTROLE = /[\x00-\x1f\x7f]/;

function filtro(c: Context, nome: string): string | undefined {
  const v = c.req.query(nome);
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s.length > 200 || CONTROLE.test(s)) {
    throw new Invalido(`Filtro ${nome} inválido`);
  }
  return s || undefined;
}

function sim(c: Context, nome: string): boolean {
  const v = c.req.query(nome);
  if (v === undefined || v === "") return false;
  if (/^(1|true|sim)$/i.test(v)) return true;
  if (/^(0|false|nao|não)$/i.test(v)) return false;
  throw new Invalido(`Filtro ${nome} inválido`);
}

function dia(c: Context, nome: string): Date | undefined {
  const v = c.req.query(nome);
  if (!v) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Invalido(`Filtro ${nome} inválido (use AAAA-MM-DD)`);
  }
  const d = new Date(`${v}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw new Invalido(`Filtro ${nome} inválido`);
  }
  return d;
}

function limiteDe(c: Context): number {
  const v = c.req.query("limite");
  if (!v) return LIMITE_BUSCA;
  const n = /^\d{1,3}$/.test(v) ? Number(v) : 0;
  if (n < 1 || n > LIMITE_BUSCA) throw new Invalido("Limite inválido");
  return n;
}

export function rotasPastas(d: PastasDeps): Hono {
  const { sql, pool } = d;
  const app = new Hono();
  const json = limiteCorpo();

  app.get(
    "/:id/pastas",
    comCaixa("pastas", async (c, id) => {
      const pastas = await pool.comImap(id, (cli) => pastasComContagem(cli));
      return c.json({ pastas });
    }),
  );

  app.post(
    "/:id/pastas",
    json,
    comCaixa("pastas", async (c, id) => {
      const b = await corpo(c, NovaPasta);
      if (!b.ok) return b.r;
      const r = await pool.comImap(id, async (cli, cx) => {
        const caminho = await criarPasta(cli, b.v.nome, b.v.pai ?? null);
        const pasta = (await pastasComContagem(cli)).find((p) =>
          p.caminho === caminho
        ) ?? null;
        return { caminho, pasta, endereco: cx.endereco };
      });
      await auditarPasta(sql, "pasta_criada", r.endereco, {
        pasta: r.caminho,
      });
      return c.json({ ok: true, caminho: r.caminho, pasta: r.pasta }, 201);
    }),
  );

  app.patch(
    "/:id/pastas",
    json,
    comCaixa("pastas", async (c, id) => {
      const caminho = pastaDe(c, "");
      const b = await corpo(c, Renomear);
      if (!b.ok) return b.r;
      const r = await pool.comImap(id, async (cli, cx) => {
        const novo = await renomearPasta(cli, caminho, b.v.nome);
        const pasta = (await pastasComContagem(cli)).find((p) =>
          p.caminho === novo
        ) ?? null;
        return { novo, pasta, endereco: cx.endereco };
      });
      await auditarPasta(sql, "pasta_renomeada", r.endereco, {
        de: caminho,
        para: r.novo,
      });
      return c.json({ ok: true, caminho: r.novo, pasta: r.pasta });
    }),
  );

  app.delete(
    "/:id/pastas",
    json,
    comCaixa("pastas", async (c, id) => {
      const caminho = pastaDe(c, "");
      const endereco = await pool.comImap(id, async (cli, cx) => {
        await excluirPasta(cli, caminho);
        return cx.endereco;
      });
      await auditarPasta(sql, "pasta_excluida", endereco, { pasta: caminho });
      return c.json({ ok: true });
    }),
  );

  app.get(
    "/:id/favoritos",
    comCaixa("favoritos", async (c, id) => {
      const limite = limiteDe(c);
      const r = await pool.comImap(id, (cli) => favoritos(cli, limite));
      return c.json(r);
    }),
  );

  app.get(
    "/:id/busca",
    comCaixa("busca", async (c, id) => {
      // todas=1: todas as pastas; senão a pasta de ?pasta= (padrão INBOX).
      // Parâmetro próprio para não colidir com uma pasta chamada "todas".
      const todas = sim(c, "todas");
      if (todas && c.req.query("pasta") !== undefined) {
        throw new Invalido("Use pasta ou todas=1, não os dois");
      }
      const pasta = todas ? null : pastaDe(c);
      const f: FiltrosBusca = {
        de: filtro(c, "de"),
        para: filtro(c, "para"),
        assunto: filtro(c, "assunto"),
        texto: filtro(c, "texto"),
        temAnexo: sim(c, "temAnexo"),
        naoLidas: sim(c, "naoLidas"),
        desde: dia(c, "desde"),
        ate: dia(c, "ate"),
      };
      if (f.desde && f.ate && f.desde > f.ate) {
        throw new Invalido("Período inválido: desde depois de ate");
      }
      if (!Object.values(f).some((v) => v !== undefined && v !== false)) {
        throw new Invalido("Informe ao menos um filtro");
      }
      const limite = limiteDe(c);
      const r = await pool.comImap(id, (cli) => buscar(cli, pasta, f, limite));
      return c.json(r);
    }),
  );

  return app;
}
