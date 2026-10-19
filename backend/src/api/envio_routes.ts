// POST /api/caixas/:id/enviar (multipart) — envio imediato ou agendado.
// Campos: para, cc, cco (listas por vírgula), assunto, html, texto,
// respondendoA / encaminhando (JSON {pasta, uid}), incluirAssinatura
// (padrão true), files[] (anexos, até 25 MB no total), agendarPara (ISO:
// vai para a Caixa de saída), rascunhoUid (o rascunho é apagado depois) e
// anexosRascunho (JSON ["2","3"]: anexos do rascunho que seguem junto) e
// assinaturaId (2.0: id, "null" = nenhuma; ausente = padrão do modo).
// Falha transitória no envio imediato → Caixa de saída (202).
//
// POST /api/caixas/:id/mensagens/:uid/redirecionar (JSON) — redirecionar.
import { Hono } from "@hono/hono";
import { bodyLimit } from "@hono/hono/body-limit";
import { z } from "zod";
import {
  type AnexoEnvio,
  enviarMensagem,
  type EnvioDeps,
  LIMITE_ANEXOS,
  MAX_DESTINATARIOS,
  MENSAGEM_LIMITE_ANEXOS,
  type PedidoEnvio,
} from "../mail/envio.ts";
import {
  CaixaNaoEncontrada,
  CaixaPrecisaSenha,
  MENSAGEM_SENHA_ILEGIVEL,
} from "../mail/pool.ts";
import { obterCaixa } from "../caixas/repo.ts";
import { obterAssinatura } from "../caixas/assinaturas_repo.ts";
import {
  apagarRascunho,
  baixarPartes,
  pastaRascunhos,
} from "../mail/rascunhos.ts";
import {
  ehErroConhecido,
  ehTransitoria,
  enfileirar,
  ESPERAS_MS,
  mensagemErro,
} from "../mail/saida.ts";
import { redirecionarMensagem } from "../mail/redirecionar.ts";
import {
  anexosDe,
  arquivos,
  camposComposer,
  CONTROLE,
  dataHora,
  type Formulario,
  Invalido,
  partes,
  somaArquivos,
  uidOpcional,
} from "./formulario.ts";
import { comCaixa, pastaDe, uidDe } from "./erros.ts";
import { corpo, limiteCorpo } from "./util.ts";

/** Anexos + campos de texto + sobra do multipart. */
export const LIMITE_CORPO_ENVIO = LIMITE_ANEXOS + 1024 * 1024;
/** Agendamento: no máximo um ano à frente. */
const MAX_AGENDAMENTO_MS = 366 * 86_400_000;

const Redirecionar = z.object({
  pasta: z.string().min(1).max(500).refine((s) => !CONTROLE.test(s))
    .optional(),
  para: z.union([
    z.string().max(20_000),
    z.array(z.string().max(254)).max(MAX_DESTINATARIOS),
  ]),
});

/** Lê os anexos do rascunho (antes de ele ser apagado). */
async function anexosDoRascunho(
  d: EnvioDeps,
  id: number,
  uid: number | undefined,
  ps: string[],
  jaUsado: number,
): Promise<AnexoEnvio[]> {
  if (!ps.length) return [];
  if (!uid) throw new Invalido("anexosRascunho exige rascunhoUid");
  return await d.pool.comImap(id, async (cli) => {
    const pasta = await pastaRascunhos(cli);
    return await baixarPartes(cli, pasta, uid, ps, LIMITE_ANEXOS - jaUsado);
  });
}

/** Apaga o rascunho depois do envio/enfileiramento; nunca lança. */
async function descartarRascunho(
  d: EnvioDeps,
  id: number,
  uid: number,
): Promise<boolean> {
  try {
    return await d.pool.comImap(id, (cli) => apagarRascunho(cli, uid));
  } catch (e) {
    console.error(
      "[envio] falha ao apagar o rascunho:",
      (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
    );
    return false;
  }
}

export function rotasEnvio(d: EnvioDeps): Hono {
  const app = new Hono();
  const agora = () => (d.agora ?? (() => new Date()))();

  app.post(
    "/:id/enviar",
    bodyLimit({
      maxSize: LIMITE_CORPO_ENVIO,
      onError: (c) => c.json({ erro: MENSAGEM_LIMITE_ANEXOS }, 413),
    }),
    comCaixa("envio", async (c, id) => {
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
      const campos = camposComposer(form, true);
      const agendarPara = dataHora(form.agendarPara, "agendarPara");
      const rascunhoUid = uidOpcional(form.rascunhoUid, "rascunhoUid");
      const doRascunho = partes(form.anexosRascunho, "anexosRascunho");
      const t0 = agora();
      if (agendarPara) {
        if (agendarPara.getTime() <= t0.getTime()) {
          throw new Invalido("agendarPara deve estar no futuro");
        }
        if (agendarPara.getTime() - t0.getTime() > MAX_AGENDAMENTO_MS) {
          throw new Invalido("agendarPara: no máximo um ano à frente");
        }
      }

      // a caixa antes de tocar no IMAP (404/409 sem conectar)
      const caixa = await obterCaixa(d.sql, id);
      if (!caixa) throw new CaixaNaoEncontrada();
      if (caixa.estado === "precisa_senha" && !agendarPara) {
        throw new CaixaPrecisaSenha(
          caixa.estado_motivo ? MENSAGEM_SENHA_ILEGIVEL : undefined,
        );
      }
      if (
        typeof campos.assinaturaId === "number" &&
        !(await obterAssinatura(d.sql, id, campos.assinaturaId))
      ) {
        throw new Invalido("Assinatura não encontrada nesta caixa");
      }

      const anexos = await anexosDe(files);
      anexos.push(
        ...await anexosDoRascunho(
          d,
          id,
          rascunhoUid,
          doRascunho,
          somaArquivos(files),
        ),
      );
      const pedido: PedidoEnvio = { ...campos, anexos };
      const rascunho = async () =>
        rascunhoUid
          ? { rascunhoApagado: await descartarRascunho(d, id, rascunhoUid) }
          : {};

      if (agendarPara) {
        const item = await enfileirar(d.sql, id, pedido, {
          origem: "agendado",
          quando: agendarPara,
          agora: t0,
        });
        return c.json(
          { ok: true, agendado: true, saida: item, ...await rascunho() },
          202,
        );
      }

      try {
        const r = await enviarMensagem(d, id, pedido, {
          pushFalha: "autenticacao",
        });
        return c.json({ ...r, ...await rascunho() });
      } catch (e) {
        if (!ehTransitoria(e)) {
          if (ehErroConhecido(e)) throw e;
          // desconhecido (bug, banco…): não repete nem enfileira
          console.error(
            "[envio] erro inesperado:",
            (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
          );
          return c.json({ erro: "Erro interno" }, 500);
        }
        // falha transitória: Caixa de saída, nova tentativa em 1 min
        const erro = mensagemErro(e);
        const quando = new Date(agora().getTime() + ESPERAS_MS[0]);
        const item = await enfileirar(d.sql, id, pedido, {
          origem: "falha",
          quando,
          agora: agora(),
          tentativas: 1,
          erro,
        });
        return c.json({
          ok: false,
          enfileirado: true,
          erro,
          aviso:
            "Não foi possível enviar agora. A mensagem ficou na Caixa de saída e será reenviada automaticamente.",
          saida: item,
          ...await rascunho(),
        }, 202);
      }
    }),
  );

  app.post(
    "/:id/mensagens/:uid/redirecionar",
    limiteCorpo(),
    comCaixa("redirecionar", async (c, id) => {
      const uid = uidDe(c);
      const b = await corpo(c, Redirecionar);
      if (!b.ok) return b.r;
      const pasta = b.v.pasta ?? pastaDe(c);
      const lista = Array.isArray(b.v.para) ? b.v.para.join(",") : b.v.para;
      const para = camposComposer({ para: lista }, true).para;
      const r = await redirecionarMensagem(d, id, pasta, uid, para);
      if (!r) return c.json({ erro: "Mensagem não encontrada" }, 404);
      return c.json({
        ...r,
        ...(r.rejeitados.length
          ? {
            aviso: `O servidor recusou ${r.rejeitados.length} destinatário${
              r.rejeitados.length > 1 ? "s" : ""
            }: ${r.rejeitados.join(", ")}.`,
          }
          : {}),
      });
    }),
  );

  return app;
}
