// Tradução dos erros de caixa/IMAP/SMTP/fila em respostas pt-BR, e leitura
// dos parâmetros comuns (:id, :uid, ?pasta=) das rotas de e-mail.
import type { Context } from "@hono/hono";
import { resumirErroMail } from "../mail/conexao.ts";
import { CaixaNaoEncontrada, CaixaPrecisaSenha } from "../mail/pool.ts";
import {
  MensagemGrandeDemais,
  PastaNaoEncontrada,
  SemLixeira,
} from "../mail/leitura.ts";
import {
  AnexosGrandesDemais,
  FalhaEnvio,
  MENSAGEM_LIMITE_ANEXOS,
  OriginalNaoEncontrado,
} from "../mail/envio.ts";
import {
  NomePastaInvalido,
  PastaJaExiste,
  PastaNaoVazia,
  PastaProtegida,
  SemPastaEspecial,
} from "../mail/pastas.ts";
import { AcaoInvalida, DestinoNaoEncontrado } from "../mail/lote.ts";
import { AnexoRascunhoNaoEncontrado } from "../mail/rascunhos.ts";
import { SaidaOcupada } from "../mail/saida.ts";
import { CONTROLE, Invalido, MAX_UID } from "./formulario.ts";

export { Invalido };

export function idCaixa(c: Context): number | null {
  const p = c.req.param("id") ?? "";
  return /^\d{1,9}$/.test(p) ? Number(p) : null;
}

export function uidDe(c: Context, nome = "uid"): number {
  const p = c.req.param(nome) ?? "";
  const n = /^\d{1,10}$/.test(p) ? Number(p) : 0;
  if (n < 1 || n > MAX_UID) throw new Invalido("UID inválido");
  return n;
}

export function pastaValida(p: string): boolean {
  return !!p && p.length <= 500 && !CONTROLE.test(p);
}

export function pastaDe(c: Context, padrao = "INBOX"): string {
  const p = c.req.query("pasta") ?? padrao;
  if (!pastaValida(p)) throw new Invalido("Pasta inválida");
  return p;
}

/** Erros conhecidos → status e `erro` pt-BR; o resto vira 502 resumido. */
export function respostaErro(c: Context, e: unknown, area: string): Response {
  if (e instanceof Invalido || e instanceof NomePastaInvalido) {
    return c.json({ erro: e.message }, 400);
  }
  if (e instanceof AcaoInvalida) return c.json({ erro: e.message }, 400);
  if (e instanceof CaixaNaoEncontrada) {
    return c.json({ erro: "Caixa não encontrada" }, 404);
  }
  if (e instanceof CaixaPrecisaSenha) {
    return c.json({ erro: e.message, precisaSenha: true }, 409);
  }
  if (e instanceof PastaNaoEncontrada) {
    return c.json({ erro: "Pasta não encontrada" }, 404);
  }
  if (
    e instanceof DestinoNaoEncontrado || e instanceof OriginalNaoEncontrado ||
    e instanceof AnexoRascunhoNaoEncontrado
  ) {
    return c.json({ erro: e.message }, 404);
  }
  if (e instanceof PastaProtegida) return c.json({ erro: e.message }, 403);
  if (
    e instanceof PastaJaExiste || e instanceof PastaNaoVazia ||
    e instanceof SemPastaEspecial || e instanceof SaidaOcupada
  ) {
    return c.json({ erro: e.message }, 409);
  }
  if (e instanceof SemLixeira) {
    return c.json({ erro: "Pasta Lixeira não encontrada no servidor" }, 409);
  }
  if (e instanceof AnexosGrandesDemais) {
    return c.json({ erro: MENSAGEM_LIMITE_ANEXOS }, 413);
  }
  if (e instanceof MensagemGrandeDemais) {
    return c.json({ erro: e.message }, 413);
  }
  if (e instanceof FalhaEnvio) {
    return c.json(
      { erro: e.message, ...(e.precisaSenha ? { precisaSenha: true } : {}) },
      502,
    );
  }
  console.error(
    `[${area}] falha IMAP:`,
    (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
  );
  return c.json(
    { erro: `Falha ao acessar o servidor de e-mail: ${resumirErroMail(e)}` },
    502,
  );
}

/** Envolve o handler: valida :id (404) e traduz os erros. */
export function comCaixa(
  area: string,
  fn: (c: Context, id: number) => Promise<Response>,
) {
  return async (c: Context): Promise<Response> => {
    const id = idCaixa(c);
    if (id === null) return c.json({ erro: "Caixa não encontrada" }, 404);
    try {
      return await fn(c, id);
    } catch (e) {
      return respostaErro(c, e, area);
    }
  };
}
