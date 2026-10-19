// Redirecionar (bounce/"resend"): reenvia a mensagem recebida COMO ESTÁ
// (From e corpo originais) a novos destinatários, com o bloco Resent-*
// (RFC 5322 §3.6.6) acrescentado no topo. O envelope SMTP sai da caixa.
// Nada é gravado em Enviados; o redirecionamento é auditado.
import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import {
  lerSenha,
  marcarPrecisaSenha,
  obterCaixa,
  SenhaIlegivel,
} from "../caixas/repo.ts";
import {
  type ConfigMail,
  ehFalhaAutenticacao,
  resumirErroMail,
} from "./conexao.ts";
import {
  ehRecusaPermanente,
  FalhaEnvio,
  type Transmitir,
  transmitirSmtp,
} from "./envio.ts";
import { alvoSmtp, type ResendConfig } from "./resend.ts";
import { resolverRemetenteDb } from "./resend_contas.ts";
import { type Registrador, registradorNulo } from "../db/registro.ts";
import {
  abrirPasta,
  LIMITE_MENSAGEM,
  MensagemGrandeDemais,
} from "./leitura.ts";
import {
  CaixaNaoEncontrada,
  CaixaPrecisaSenha,
  MENSAGEM_SENHA_ILEGIVEL,
  type Pool,
} from "./pool.ts";

const DIAS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MESES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const d2 = (n: number) => String(n).padStart(2, "0");

/** Data RFC 5322 em UTC: "Sat, 03 Oct 2026 12:00:00 +0000". */
export function dataRfc5322(d: Date): string {
  return `${DIAS[d.getUTCDay()]}, ${d2(d.getUTCDate())} ${
    MESES[d.getUTCMonth()]
  } ${d.getUTCFullYear()} ${d2(d.getUTCHours())}:${d2(d.getUTCMinutes())}:${
    d2(d.getUTCSeconds())
  } +0000`;
}

export interface BlocoResent {
  de: string;
  para: string[];
  data: Date;
  messageId: string;
}

/**
 * Cabeçalhos Resent-* (CRLF). Endereços já validados (sem espaços nem
 * quebras); Resent-To dobrado em uma linha por destinatário.
 */
export function cabecalhosResent(b: BlocoResent): string {
  return [
    `Resent-From: ${b.de}`,
    `Resent-To: ${b.para.join(",\r\n ")}`,
    `Resent-Date: ${dataRfc5322(b.data)}`,
    `Resent-Message-ID: ${b.messageId}`,
  ].join("\r\n") + "\r\n";
}

/** Bloco Resent-* no topo dos bytes originais, intactos. */
export function montarRedirecionamento(
  original: Uint8Array,
  b: BlocoResent,
): Uint8Array {
  return new Uint8Array(
    Buffer.concat([Buffer.from(cabecalhosResent(b), "ascii"), original]),
  );
}

/** Bytes originais da mensagem (até 50 MB). null se não existe. */
export async function lerOriginal(
  c: ImapFlow,
  pasta: string,
  uid: number,
  limite = LIMITE_MENSAGEM,
): Promise<Uint8Array | null> {
  await abrirPasta(c, pasta, true);
  const info = await c.fetchOne(String(uid), { uid: true, size: true }, {
    uid: true,
  });
  if (!info) return null;
  if ((info.size ?? 0) > limite) throw new MensagemGrandeDemais(limite);
  const m = await c.fetchOne(String(uid), { uid: true, source: true }, {
    uid: true,
  });
  return m && m.source ? new Uint8Array(m.source) : null;
}

export interface RedirecionarDeps {
  sql: Sql;
  masterKey: Uint8Array;
  mail: ConfigMail;
  pool: Pool;
  transmitir?: Transmitir;
  /** Contas Resend por domínio; ausente → tudo pelo poste.io. */
  resend?: ResendConfig;
  /** Logger de atividade/erro; ausente → não registra. */
  registro?: Registrador;
  agora?: () => Date;
}

export interface ResultadoRedirecionar {
  ok: true;
  /** Resent-Message-ID. */
  messageId: string;
  rejeitados: string[];
}

/**
 * Redireciona `uid` de `pasta` para `para`. null se a mensagem não existe.
 * Lança CaixaNaoEncontrada, CaixaPrecisaSenha, PastaNaoEncontrada,
 * MensagemGrandeDemais ou FalhaEnvio (SMTP; senha recusada → precisa_senha).
 */
export async function redirecionarMensagem(
  d: RedirecionarDeps,
  caixaId: number,
  pasta: string,
  uid: number,
  para: string[],
): Promise<ResultadoRedirecionar | null> {
  const caixa = await obterCaixa(d.sql, caixaId);
  if (!caixa) throw new CaixaNaoEncontrada();
  if (caixa.estado === "precisa_senha") {
    throw new CaixaPrecisaSenha(
      caixa.estado_motivo ? MENSAGEM_SENHA_ILEGIVEL : undefined,
    );
  }
  const original = await d.pool.comImap(
    caixaId,
    (c) => lerOriginal(c, pasta, uid),
  );
  if (!original) return null;

  const dominio = caixa.endereco.split("@")[1] || "localhost";
  const messageId = `<${crypto.randomUUID()}@${dominio}>`;
  const raw = montarRedirecionamento(original, {
    de: caixa.endereco,
    para,
    data: (d.agora ?? (() => new Date()))(),
    messageId,
  });

  let cred;
  try {
    cred = await lerSenha(d.sql, d.masterKey, caixaId);
  } catch (e) {
    if (e instanceof SenhaIlegivel) {
      throw new CaixaPrecisaSenha(MENSAGEM_SENHA_ILEGIVEL);
    }
    throw e;
  }
  if (!cred) throw new CaixaNaoEncontrada();
  const registro = d.registro ?? registradorNulo;
  const rota = await resolverRemetenteDb(d.sql, d.resend, cred.endereco);
  const alvo = alvoSmtp(rota, d.mail, cred.endereco, cred.senha);
  let rejeitados: string[];
  try {
    ({ rejeitados } = await (d.transmitir ?? transmitirSmtp)(
      alvo.cfg,
      { endereco: alvo.usuario },
      alvo.senha,
      { envelope: { from: caixa.endereco, to: para }, raw },
    ));
  } catch (e) {
    const auth = ehFalhaAutenticacao(e);
    console.error(
      "[redirecionar] falha SMTP:",
      (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
    );
    await registro.registrar({
      nivel: "erro",
      area: "envio",
      caixaId,
      mensagem:
        `Falha ao redirecionar de ${caixa.endereco} via ${alvo.descricao}: ${
          resumirErroMail(e)
        }`,
      detalhe: { via: alvo.descricao, auth },
    });
    if (auth) {
      try {
        await marcarPrecisaSenha(d.sql, caixaId, cred.senhaCifrada);
      } catch { /* best-effort */ }
    }
    throw new FalhaEnvio(
      resumirErroMail(e),
      auth,
      !auth && ehRecusaPermanente(e),
      e,
    );
  }

  try {
    await auditar(d.sql, "usuario", "mensagem_redirecionada", caixa.endereco, {
      pasta,
      uid,
      messageId,
      destinatarios: para.length,
      rejeitados,
    });
  } catch (e) {
    console.error("[redirecionar] falha ao auditar:", (e as Error)?.name);
  }
  await registro.registrar({
    nivel: "info",
    area: "envio",
    caixaId,
    mensagem:
      `Mensagem redirecionada de ${caixa.endereco} via ${alvo.descricao}`,
    detalhe: { via: alvo.descricao, destinatarios: para.length },
  });
  return { ok: true, messageId, rejeitados };
}
