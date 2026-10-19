// /api/caixas/:id/saida — Caixa de saída (agendados e falhas de envio).
import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { dividirEnderecos, MAX_DESTINATARIOS } from "../mail/envio.ts";
import {
  type AlteracaoSaida,
  cancelarSaida,
  editarSaida,
  listarSaida,
  marcarParaJa,
  obterSaida,
} from "../mail/saida.ts";
import { comCaixa, Invalido } from "./erros.ts";
import { MAX_ASSUNTO, MAX_HTML, MAX_TEXTO } from "./formulario.ts";
import { corpo, limiteCorpo } from "./util.ts";

export interface SaidaDeps {
  sql: Sql;
  /** Roda uma rodada do worker (reenviar agora). */
  fila: { executar(): Promise<unknown> };
  agora?: () => Date;
}

const Lista = z.union([
  z.string().max(20_000),
  z.array(z.string().max(254)).max(MAX_DESTINATARIOS),
]);

const Alteracao = z.object({
  para: Lista.optional(),
  cc: Lista.optional(),
  cco: Lista.optional(),
  assunto: z.string().max(MAX_ASSUNTO).optional(),
  html: z.string().max(MAX_HTML).optional(),
  texto: z.string().max(MAX_TEXTO).nullable().optional(),
  incluirAssinatura: z.boolean().optional(),
  agendarPara: z.string().datetime({ offset: true }).optional(),
}).strict();

const MAX_AGENDAMENTO_MS = 366 * 86_400_000;

function lista(v: string | string[] | undefined, nome: string) {
  if (v === undefined) return undefined;
  const r = dividirEnderecos(Array.isArray(v) ? v.join(",") : v);
  if (!r.ok) throw new Invalido(`Endereço inválido em ${nome}: ${r.invalido}`);
  return r.enderecos;
}

function idSaida(c: Context): number {
  const p = c.req.param("sid") ?? "";
  if (!/^\d{1,9}$/.test(p)) throw new Invalido("Item inválido");
  return Number(p);
}

const naoEncontrado = (c: Context) =>
  c.json({ erro: "Item da Caixa de saída não encontrado" }, 404);

export function rotasSaida(d: SaidaDeps): Hono {
  const { sql } = d;
  const agora = d.agora ?? (() => new Date());
  const app = new Hono();

  app.get(
    "/:id/saida",
    comCaixa("saida", async (c, id) => {
      return c.json({ itens: await listarSaida(sql, id) });
    }),
  );

  app.get(
    "/:id/saida/:sid",
    comCaixa("saida", async (c, id) => {
      const it = await obterSaida(sql, id, idSaida(c));
      return it ? c.json({ item: it }) : naoEncontrado(c);
    }),
  );

  app.patch(
    "/:id/saida/:sid",
    limiteCorpo(MAX_HTML + MAX_TEXTO + 64 * 1024),
    comCaixa("saida", async (c, id) => {
      const sid = idSaida(c);
      const b = await corpo(c, Alteracao);
      if (!b.ok) return b.r;
      const v = b.v;
      const a: AlteracaoSaida = {
        para: lista(v.para, "para"),
        cc: lista(v.cc, "cc"),
        cco: lista(v.cco, "cco"),
        assunto: v.assunto?.replace(/[\r\n]+/g, " "),
        html: v.html,
        texto: v.texto,
        incluirAssinatura: v.incluirAssinatura,
      };
      if (v.agendarPara) {
        const quando = new Date(v.agendarPara);
        const t0 = agora().getTime();
        if (quando.getTime() <= t0) {
          throw new Invalido("agendarPara deve estar no futuro");
        }
        if (quando.getTime() - t0 > MAX_AGENDAMENTO_MS) {
          throw new Invalido("agendarPara: no máximo um ano à frente");
        }
        a.agendarPara = quando;
      }
      const atual = await obterSaida(sql, id, sid);
      if (!atual) return naoEncontrado(c);
      const destinatarios = new Set([
        ...(a.para ?? atual.para),
        ...(a.cc ?? atual.cc),
        ...(a.cco ?? atual.cco),
      ]).size;
      if (destinatarios === 0) {
        throw new Invalido("Informe ao menos um destinatário");
      }
      if (destinatarios > MAX_DESTINATARIOS) {
        throw new Invalido(
          `No máximo ${MAX_DESTINATARIOS} destinatários por mensagem`,
        );
      }
      const it = await editarSaida(sql, id, sid, a, agora());
      return it ? c.json({ ok: true, item: it }) : naoEncontrado(c);
    }),
  );

  app.delete(
    "/:id/saida/:sid",
    comCaixa("saida", async (c, id) => {
      const ok = await cancelarSaida(sql, id, idSaida(c));
      return ok ? c.json({ ok: true }) : naoEncontrado(c);
    }),
  );

  app.post(
    "/:id/saida/:sid/reenviar",
    comCaixa("saida", async (c, id) => {
      const sid = idSaida(c);
      const it = await marcarParaJa(sql, id, sid, agora());
      if (!it) return naoEncontrado(c);
      await d.fila.executar();
      const depois = await obterSaida(sql, id, sid);
      return c.json({
        ok: true,
        enviado: depois === null,
        item: depois,
      });
    }),
  );

  return app;
}
