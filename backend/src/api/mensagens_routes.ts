// /api/caixas/:id/pastas e /api/caixas/:id/mensagens/* — leitura de e-mail.
// Uma conexão IMAP curta por requisição (pool.ts); senha recusada → 409 e a
// caixa fica em precisa_senha.
import { type Context, Hono } from "@hono/hono";
import { finished, Readable } from "node:stream";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import { corpo, limiteCorpo } from "./util.ts";
import { resumirErroMail } from "../mail/conexao.ts";
import {
  type Classificador,
  comPrazo,
  suspeitaDe,
} from "../ai/classificador.ts";
import {
  CaixaNaoEncontrada,
  CaixaPrecisaSenha,
  type Pool,
} from "../mail/pool.ts";
import {
  abrirAnexo,
  apagarMensagem,
  cabecalhoDisposicao,
  lerMensagemCompleta,
  listarMensagens,
  listarPastas,
  marcarLida,
  MensagemGrandeDemais,
  moverMensagem,
  PastaNaoEncontrada,
  SemLixeira,
  tipoDownload,
} from "../mail/leitura.ts";
import { ACOES_LOTE, executarLote, MAX_LOTE } from "../mail/lote.ts";
import { respostaErro } from "./erros.ts";

export interface MensagensDeps {
  sql: Sql;
  pool: Pool;
  /** Duração máxima de um download de anexo. Padrão 10 min. */
  prazoDownloadMs?: number;
  /** Selo de suspeita no detalhe; sem ele, `suspeita` é sempre null. */
  classificador?: Classificador;
  /** Quanto o detalhe espera uma classificação sob demanda. Padrão 5 s. */
  prazoClassificacaoMs?: number;
}

export const PRAZO_CLASSIFICACAO_MS = 5_000;

export const PRAZO_DOWNLOAD_MS = 10 * 60_000;

/**
 * Libera a conexão quando o stream termina, falha ou é cancelado; após
 * `prazoMs` destrói o stream (que então libera). `liberar` roda uma vez.
 */
export function amarrarStream(
  conteudo: Readable,
  prazoMs: number,
  liberar: () => Promise<void>,
): void {
  let feito = false;
  const timer = setTimeout(() => {
    console.error("[mensagens] download excedeu o prazo; encerrado");
    conteudo.destroy(new Error("prazo do download esgotado"));
  }, prazoMs);
  finished(conteudo, () => {
    clearTimeout(timer);
    if (feito) return;
    feito = true;
    liberar().catch(() => {});
  });
}

const MAX_UID = 4294967295;

class Invalido extends Error {}

function idCaixa(c: Context): number | null {
  const p = c.req.param("id") ?? "";
  return /^\d{1,9}$/.test(p) ? Number(p) : null;
}

function uidDe(c: Context): number {
  const p = c.req.param("uid") ?? "";
  const n = /^\d{1,10}$/.test(p) ? Number(p) : 0;
  if (n < 1 || n > MAX_UID) throw new Invalido("UID inválido");
  return n;
}

// deno-lint-ignore no-control-regex
const CONTROLE = /[\x00-\x1f\x7f]/;

function pastaDe(c: Context): string {
  const p = c.req.query("pasta") ?? "INBOX";
  if (!p || p.length > 500 || CONTROLE.test(p)) {
    throw new Invalido("Pasta inválida");
  }
  return p;
}

const Marcas = z.object({
  lida: z.boolean().optional(),
  estrela: z.boolean().optional(),
}).refine((x) => x.lida !== undefined || x.estrela !== undefined, {
  message: "Informe lida e/ou estrela",
});
const Lote = z.object({
  pasta: z.string().min(1).max(500).refine((s) => !CONTROLE.test(s)),
  uids: z.array(z.number().int().min(1).max(MAX_UID)).min(1).max(MAX_LOTE),
  acao: z.enum(ACOES_LOTE),
  destino: z.string().min(1).max(500).refine((s) => !CONTROLE.test(s))
    .optional(),
});
const Destino = z.object({
  destino: z.string().min(1).max(500).refine((s) => !CONTROLE.test(s), {
    message: "Pasta inválida",
  }),
});

/** Traduz erros de caixa/IMAP em respostas pt-BR. */
function erroParaResposta(c: Context, e: unknown): Response {
  if (e instanceof Invalido) return c.json({ erro: e.message }, 400);
  if (e instanceof CaixaNaoEncontrada) {
    return c.json({ erro: "Caixa não encontrada" }, 404);
  }
  if (e instanceof CaixaPrecisaSenha) {
    return c.json({ erro: e.message, precisaSenha: true }, 409);
  }
  if (e instanceof PastaNaoEncontrada) {
    return c.json({ erro: "Pasta não encontrada" }, 404);
  }
  if (e instanceof MensagemGrandeDemais) {
    return c.json({ erro: e.message }, 413);
  }
  if (e instanceof SemLixeira) {
    return c.json({ erro: "Pasta Lixeira não encontrada no servidor" }, 409);
  }
  const resumo = resumirErroMail(e);
  console.error(
    "[mensagens] falha IMAP:",
    (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
  );
  return c.json(
    { erro: `Falha ao acessar o servidor de e-mail: ${resumo}` },
    502,
  );
}

const naoEncontrada = (c: Context) =>
  c.json({ erro: "Mensagem não encontrada" }, 404);

export function rotasMensagens(d: MensagensDeps): Hono {
  const { sql, pool } = d;
  const prazoDownloadMs = d.prazoDownloadMs ?? PRAZO_DOWNLOAD_MS;
  const app = new Hono();
  const json = limiteCorpo();

  /** Valida o id da caixa e trata os erros comuns. */
  const com = (
    fn: (c: Context, id: number) => Promise<Response>,
  ) =>
  async (c: Context) => {
    const id = idCaixa(c);
    if (id === null) return c.json({ erro: "Caixa não encontrada" }, 404);
    try {
      return await fn(c, id);
    } catch (e) {
      return erroParaResposta(c, e);
    }
  };

  app.get(
    "/:id/mensagens",
    com(async (c, id) => {
      const pasta = pastaDe(c);
      const pg = c.req.query("pagina") ?? "1";
      if (!/^\d{1,5}$/.test(pg) || Number(pg) < 1) {
        throw new Invalido("Página inválida");
      }
      const busca = c.req.query("busca") ?? "";
      if (busca.length > 200) throw new Invalido("Busca longa demais");
      const r = await pool.comImap(
        id,
        (cli) => listarMensagens(cli, pasta, { pagina: Number(pg), busca }),
      );
      return c.json(r);
    }),
  );

  app.get(
    "/:id/mensagens/:uid",
    com(async (c, id) => {
      const uid = uidDe(c);
      const pasta = pastaDe(c);
      const r = await pool.comImap(
        id,
        (cli) => lerMensagemCompleta(cli, pasta, uid),
      );
      if (!r) return naoEncontrada(c);
      const m = r.mensagem;
      const cl = d.classificador;
      if (cl) {
        // fora do mutex da caixa; o veredito atrasado fica no cache
        // a UIDVALIDITY da pasta faz parte da chave do cache
        let v = await cl.emCache(id, pasta, r.uidValidity, uid);
        if (!v && await cl.ativo()) {
          v = await comPrazo(
            cl.classificar(id, pasta, r.uidValidity, uid, r.email),
            d.prazoClassificacaoMs ?? PRAZO_CLASSIFICACAO_MS,
          );
        }
        const s = suspeitaDe(v);
        m.suspeita = s
          ? {
            classe: s.classe as "spam" | "phishing",
            confianca: s.confianca,
            motivo: s.motivo,
          }
          : null;
      }
      return c.json({ mensagem: m });
    }),
  );

  app.get(
    "/:id/mensagens/:uid/anexos/:parte",
    com(async (c, id) => {
      const uid = uidDe(c);
      const pasta = pastaDe(c);
      const parte = c.req.param("parte") ?? "";
      if (parte.length > 40 || !/^\d+(\.\d+)*$/.test(parte)) {
        throw new Invalido("Anexo inválido");
      }
      const r = await pool.reservar(id);
      let anexo;
      try {
        anexo = await abrirAnexo(r.cliente, pasta, uid, parte);
      } catch (e) {
        await r.liberar();
        throw e;
      }
      if (!anexo) {
        await r.liberar();
        return c.json({ erro: "Anexo não encontrado" }, 404);
      }
      try {
        const cabecalhos = {
          "Content-Type": tipoDownload(anexo.tipo),
          "Content-Disposition": cabecalhoDisposicao(anexo.nome),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "private, no-store",
        };
        // conexão e mutex presos até o fim, cancelamento ou prazo do stream
        amarrarStream(anexo.conteudo, prazoDownloadMs, r.liberar);
        const corpoStream = Readable.toWeb(anexo.conteudo) as ReadableStream<
          Uint8Array
        >;
        return c.body(corpoStream, 200, cabecalhos);
      } catch (e) {
        anexo.conteudo.destroy();
        await r.liberar();
        throw e;
      }
    }),
  );

  app.patch(
    "/:id/mensagens/:uid",
    json,
    com(async (c, id) => {
      const uid = uidDe(c);
      const pasta = pastaDe(c);
      const b = await corpo(c, Marcas);
      if (!b.ok) return b.r;
      const { lida, estrela } = b.v;
      const ok = await pool.comImap(id, async (cli) => {
        if (lida !== undefined && !await marcarLida(cli, pasta, uid, lida)) {
          return false;
        }
        if (estrela !== undefined) {
          const r = await executarLote(
            cli,
            pasta,
            [uid],
            estrela ? "estrela" : "sem_estrela",
          );
          if (!r.afetadas) return false;
        }
        return true;
      });
      return ok
        ? c.json({
          ok: true,
          ...(lida !== undefined ? { lida } : {}),
          ...(estrela !== undefined ? { estrela } : {}),
        })
        : naoEncontrada(c);
    }),
  );

  app.post(
    "/:id/mensagens/lote",
    json,
    async (c) => {
      const id = idCaixa(c);
      if (id === null) return c.json({ erro: "Caixa não encontrada" }, 404);
      try {
        const b = await corpo(c, Lote);
        if (!b.ok) return b.r;
        const { pasta, uids, acao, destino } = b.v;
        const r = await pool.comImap(id, async (cli, caixa) => ({
          res: await executarLote(cli, pasta, uids, acao, destino),
          endereco: caixa.endereco,
        }));
        if (acao === "excluir" && r.res.afetadas) {
          try {
            await auditar(
              sql,
              "usuario",
              r.res.resultado === "apagadas"
                ? "mensagens_apagadas"
                : "mensagens_lixeira",
              r.endereco,
              { pasta, quantidade: r.res.afetadas },
            );
          } catch (e) {
            console.error("[mensagens] falha ao auditar:", (e as Error)?.name);
          }
        }
        return c.json({ ok: true, ...r.res });
      } catch (e) {
        return respostaErro(c, e, "mensagens");
      }
    },
  );

  app.post(
    "/:id/mensagens/:uid/mover",
    json,
    com(async (c, id) => {
      const uid = uidDe(c);
      const pasta = pastaDe(c);
      const b = await corpo(c, Destino);
      if (!b.ok) return b.r;
      const destino = b.v.destino;
      if (destino === pasta) {
        return c.json({ erro: "A mensagem já está nessa pasta" }, 400);
      }
      const r = await pool.comImap(id, async (cli) => {
        const pastas = await listarPastas(cli);
        if (!pastas.some((p) => p.caminho === destino)) return "sem-destino";
        return await moverMensagem(cli, pasta, uid, destino);
      });
      if (r === "sem-destino") {
        return c.json({ erro: "Pasta de destino não encontrada" }, 404);
      }
      return r ? c.json({ ok: true, destino, uid: r.uid }) : naoEncontrada(c);
    }),
  );

  app.delete(
    "/:id/mensagens/:uid",
    json,
    com(async (c, id) => {
      const uid = uidDe(c);
      const pasta = pastaDe(c);
      const r = await pool.comImap(id, async (cli, caixa) => {
        const acao = await apagarMensagem(cli, pasta, uid);
        return { acao, endereco: caixa.endereco };
      });
      if (!r.acao) return naoEncontrada(c);
      try {
        await auditar(
          sql,
          "usuario",
          r.acao === "lixeira" ? "mensagem_lixeira" : "mensagem_apagada",
          r.endereco,
          { pasta, uid },
        );
      } catch (e) {
        console.error("[mensagens] falha ao auditar:", (e as Error)?.name);
      }
      return c.json({ ok: true, acao: r.acao });
    }),
  );

  return app;
}
