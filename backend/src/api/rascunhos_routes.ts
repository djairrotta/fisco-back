// /api/caixas/:id/rascunhos — rascunhos no servidor (pasta Rascunhos).
// PUT (multipart): grava um novo rascunho e, com substituiUid, apaga o
// anterior; anexosRascunho (JSON ["2","3"]) copia anexos do anterior.
import { Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import type { Sql } from "../db/client.ts";
import { obterCaixa } from "../caixas/repo.ts";
import { MENSAGEM_LIMITE_ANEXOS } from "../mail/envio.ts";
import { CaixaNaoEncontrada, type Pool } from "../mail/pool.ts";
import {
  apagarRascunho,
  baixarPartes,
  comporRascunho,
  lerRascunho,
  pastaRascunhos,
  salvarRascunho,
} from "../mail/rascunhos.ts";
import {
  anexosDe,
  arquivos,
  camposComposer,
  type Formulario,
  Invalido,
  LIMITE_ANEXOS,
  partes,
  somaArquivos,
  uidOpcional,
} from "./formulario.ts";
import { comCaixa, uidDe } from "./erros.ts";
import { LIMITE_CORPO_ENVIO } from "./envio_routes.ts";

export interface RascunhosDeps {
  sql: Sql;
  pool: Pool;
  agora?: () => Date;
}

export function rotasRascunhos(d: RascunhosDeps): Hono {
  const { sql, pool } = d;
  const agora = d.agora ?? (() => new Date());
  const app = new Hono();

  app.put(
    "/:id/rascunhos",
    bodyLimit({
      maxSize: LIMITE_CORPO_ENVIO,
      onError: (c) => c.json({ erro: MENSAGEM_LIMITE_ANEXOS }, 413),
    }),
    comCaixa("rascunhos", async (c, id) => {
      const ct = (c.req.header("Content-Type") ?? "").toLowerCase();
      if (!ct.startsWith("multipart/form-data")) {
        return c.json({ erro: "Envie como multipart/form-data" }, 415);
      }
      let form: Formulario;
      try {
        form = await c.req.parseBody({ all: true }) as Formulario;
      } catch {
        throw new Invalido("Formulário inválido");
      }
      const files = arquivos(form);
      if (somaArquivos(files) > LIMITE_ANEXOS) {
        return c.json({ erro: MENSAGEM_LIMITE_ANEXOS }, 413);
      }
      const campos = camposComposer(form, false);
      const substituiUid = uidOpcional(form.substituiUid, "substituiUid");
      const mantidos = partes(form.anexosRascunho, "anexosRascunho");
      if (mantidos.length && !substituiUid) {
        throw new Invalido("anexosRascunho exige substituiUid");
      }
      const caixa = await obterCaixa(sql, id);
      if (!caixa) throw new CaixaNaoEncontrada();
      const anexos = await anexosDe(files);

      const r = await pool.comImap(id, async (cli) => {
        const pasta = await pastaRascunhos(cli);
        if (mantidos.length) {
          anexos.push(
            ...await baixarPartes(
              cli,
              pasta,
              substituiUid!,
              mantidos,
              LIMITE_ANEXOS - somaArquivos(files),
            ),
          );
        }
        const m = await comporRascunho({
          de: { nome: caixa.nome_exibicao ?? "", endereco: caixa.endereco },
          para: campos.para,
          cc: campos.cc,
          cco: campos.cco,
          assunto: campos.assunto,
          html: campos.html,
          texto: campos.texto,
          meta: {
            ...(campos.respondendoA
              ? { respondendoA: campos.respondendoA }
              : {}),
            ...(campos.encaminhando
              ? { encaminhando: campos.encaminhando }
              : {}),
            incluirAssinatura: campos.incluirAssinatura,
            ...(campos.assinaturaId !== undefined
              ? { assinaturaId: campos.assinaturaId }
              : {}),
          },
          anexos,
          data: agora(),
        });
        return await salvarRascunho(
          cli,
          pasta,
          m.raw,
          m.messageId,
          substituiUid,
        );
      });
      return c.json({ ok: true, ...r });
    }),
  );

  app.get(
    "/:id/rascunhos/:uid",
    comCaixa("rascunhos", async (c, id) => {
      const uid = uidDe(c);
      const r = await pool.comImap(id, (cli) => lerRascunho(cli, uid));
      if (!r) return c.json({ erro: "Rascunho não encontrado" }, 404);
      return c.json({ rascunho: r });
    }),
  );

  app.delete(
    "/:id/rascunhos/:uid",
    comCaixa("rascunhos", async (c, id) => {
      const uid = uidDe(c);
      const ok = await pool.comImap(id, (cli) => apagarRascunho(cli, uid));
      if (!ok) return c.json({ erro: "Rascunho não encontrado" }, 404);
      return c.json({ ok: true });
    }),
  );

  return app;
}
