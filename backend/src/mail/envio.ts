// Envio de e-mail: compõe o MIME uma vez (MailComposer), envia esses bytes
// por SMTP (envelope + raw) e grava os MESMOS bytes em Enviados com \Seen,
// de modo que Enviados é exatamente o que saiu.
//
// Regras: o remetente é sempre a caixa (com o nome de exibição); o HTML do
// usuário é sanitizado no servidor; a assinatura vem antes da citação; Cco
// só no envelope; anexos somam no máximo 25 MB (incluídos os encaminhados).
import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
// @ts-types="@types/nodemailer/lib/mail-composer/index.d.ts"
import MailComposer from "nodemailer/lib/mail-composer/index.js";
// @ts-types="@types/nodemailer/lib/mailer/index.d.ts"
import type Mail from "nodemailer/lib/mailer/index.js";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import {
  type CamposAssinatura,
  CID_LOGO,
  escaparHtml,
  gerarAssinatura,
} from "../caixas/assinatura.ts";
import type { AssinaturaGerada } from "../caixas/modelos_assinatura.ts";
import { assinaturaParaEnvio } from "../caixas/assinaturas_repo.ts";
import {
  lerSenha,
  marcarPrecisaSenha,
  obterCaixa,
  SenhaIlegivel,
} from "../caixas/repo.ts";
import {
  abrirSmtp,
  type CaixaLogin,
  type ConfigMail,
  ehFalhaAutenticacao,
  resumirErroMail,
} from "./conexao.ts";
import { alvoSmtp, type ResendConfig } from "./resend.ts";
import { resolverRemetenteDb } from "./resend_contas.ts";
import { type Registrador, registradorNulo } from "../db/registro.ts";
import {
  abrirAnexo,
  type Endereco,
  lerMensagem,
  listarPastas,
  type MensagemDetalhe,
} from "./leitura.ts";
import {
  CaixaNaoEncontrada,
  CaixaPrecisaSenha,
  MENSAGEM_SENHA_ILEGIVEL,
  type Pool,
} from "./pool.ts";
import { htmlParaTexto, sanitizarHtml } from "./sanitizar.ts";
import {
  disparar,
  notificar,
  type NotificarDeps,
} from "../notify/notificar.ts";

// ------------------------------------------------------------ limites e erros

export const LIMITE_ANEXOS = 25 * 1024 * 1024;
export const MENSAGEM_LIMITE_ANEXOS =
  "Os anexos passam do limite de 25 MB por mensagem.";
export const MAX_DESTINATARIOS = 100;

export class AnexosGrandesDemais extends Error {
  constructor() {
    super(MENSAGEM_LIMITE_ANEXOS);
    this.name = "AnexosGrandesDemais";
  }
}

export class OriginalNaoEncontrado extends Error {
  constructor() {
    super("Mensagem original não encontrada");
    this.name = "OriginalNaoEncontrado";
  }
}

/**
 * Códigos de erro de rede que valem nova tentativa (Node, imapflow e
 * nodemailer: ESOCKET/ECONNECTION/EDNS embrulham falhas de conexão).
 */
export const CODIGOS_REDE = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "ESOCKET",
  "ETIMEOUT",
  "ENOTFOUND",
  "ECONNECTION",
  "EDNS",
]);

/** Erro de rede conhecido ou resposta SMTP 4xx (temporária). */
export function ehErroTemporario(e: unknown): boolean {
  const x = e as { code?: unknown; responseCode?: unknown } | null;
  if (typeof x?.code === "string" && CODIGOS_REDE.has(x.code)) return true;
  const rc = x?.responseCode;
  return typeof rc === "number" && rc >= 400 && rc < 500;
}

/**
 * O SMTP recusou ou falhou; nada foi enviado. `permanente`: recusa 5xx.
 * `temporaria`: a causa é um erro de rede conhecido ou SMTP 4xx (vale
 * repetir); qualquer outra causa não é repetida.
 */
export class FalhaEnvio extends Error {
  public readonly temporaria: boolean;
  constructor(
    public resumo: string,
    public precisaSenha: boolean,
    public permanente = false,
    causa?: unknown,
  ) {
    super(`Falha ao enviar: ${resumo}`);
    this.name = "FalhaEnvio";
    this.temporaria = !precisaSenha && !permanente && ehErroTemporario(causa);
  }
}

/** Código SMTP 5xx (exceto autenticação, tratada à parte). */
export function ehRecusaPermanente(e: unknown): boolean {
  const c = (e as { responseCode?: unknown })?.responseCode;
  return typeof c === "number" && c >= 500 && c < 600;
}

// ------------------------------------------------------------ endereços e assunto

const Email = z.string().max(254).email();

/** Lista "a@x, b@y; c@z" → endereços válidos, minúsculos, sem duplicados. */
export function dividirEnderecos(
  s: string | undefined,
): { ok: true; enderecos: string[] } | { ok: false; invalido: string } {
  const out: string[] = [];
  for (const bruto of (s ?? "").split(/[,;]/)) {
    const e = bruto.trim();
    if (!e) continue;
    if (!Email.safeParse(e).success || /\s/.test(e)) {
      return { ok: false, invalido: e.slice(0, 100) };
    }
    const l = e.toLowerCase();
    if (!out.includes(l)) out.push(l);
  }
  return { ok: true, enderecos: out };
}

/** Nome de arquivo sem caracteres de controle (CR/LF), até 255 chars. */
export function nomeArquivo(n: string): string {
  // deno-lint-ignore no-control-regex
  return n.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 255) || "anexo";
}

/** Nome de exibição sem caracteres de controle (evita injeção de cabeçalho). */
function nomeExibicao(n: string): string {
  // deno-lint-ignore no-control-regex
  return n.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim()
    .slice(0, 200);
}

export type ModoOriginal = "resposta" | "encaminhamento";

/** Assunto informado (sem quebras de linha) ou o padrão Re:/Enc:. */
export function assuntoPadrao(
  informado: string,
  modo: ModoOriginal | undefined,
  original: string,
): string {
  // deno-lint-ignore no-control-regex
  const limpo = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const a = limpo(informado);
  if (a || !modo) return a;
  const o = limpo(original);
  if (modo === "resposta") return /^re:/i.test(o) ? o : `Re: ${o}`;
  return /^(enc|fwd?|tr):/i.test(o) ? o : `Enc: ${o}`;
}

// ------------------------------------------------------------ composição

/** O necessário da mensagem original para citar/encaminhar. */
export type Original = Pick<
  MensagemDetalhe,
  | "messageId"
  | "references"
  | "assunto"
  | "de"
  | "para"
  | "cc"
  | "data"
  | "html"
  | "texto"
>;

export interface AnexoEnvio {
  nome: string;
  tipo: string;
  conteudo: Uint8Array;
}

export interface Composicao {
  de: Endereco;
  para: string[];
  cc: string[];
  cco: string[];
  assunto: string;
  /** HTML do editor (será sanitizado). */
  html: string;
  /** Texto puro do editor; ausente → derivado do HTML. */
  texto?: string;
  /**
   * null/ausente: sem assinatura. 2.0: a assinatura já gerada (HTML, texto
   * e imagens inline por CID). 1.0: os campos legados e o logo da caixa.
   */
  assinatura?:
    | AssinaturaGerada
    | {
      campos: CamposAssinatura;
      logo?: { bytes: Uint8Array; mime: string } | null;
    }
    | null;
  original?: { modo: ModoOriginal; msg: Original };
  anexos?: AnexoEnvio[];
  messageId?: string;
  data?: Date;
  /** Rascunho: mantém o cabeçalho Bcc (no envio ele nunca aparece). */
  manterCco?: boolean;
  /** Rascunho: HTML do corpo sem o <div> envolvente (reabre igual no editor). */
  semInvolucro?: boolean;
  /** Cabeçalhos extras (valores ASCII sem quebra de linha). */
  cabecalhos?: Record<string, string>;
}

export interface Composta {
  raw: Uint8Array;
  envelope: { from: string; to: string[] };
  messageId: string;
  assunto: string;
}

const FMT_DATA = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function dataLegivel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : FMT_DATA.format(d);
}

function nomeEndereco(e: Endereco | null): string {
  if (!e) return "remetente desconhecido";
  return e.nome ? `${e.nome} <${e.endereco}>` : e.endereco;
}

function textoParaHtml(t: string): string {
  return escaparHtml(t).replace(/\r?\n/g, "<br />");
}

/** Corpo do original já seguro para HTML (sanitizado ou texto escapado). */
function corpoOriginalHtml(o: Original): string {
  const h = o.html ? sanitizarHtml(o.html) : "";
  if (h.trim()) return h;
  return textoParaHtml(o.texto ?? "");
}

function corpoOriginalTexto(o: Original): string {
  const t = o.texto?.trim() ? o.texto : htmlParaTexto(o.html ?? "");
  return t.replace(/\r\n/g, "\n").trimEnd();
}

function citacao(
  modo: ModoOriginal,
  o: Original,
): { html: string; texto: string } {
  const data = dataLegivel(o.data);
  if (modo === "resposta") {
    const linha = `${data ? `Em ${data}, ` : ""}${
      nomeEndereco(o.de)
    } escreveu:`;
    return {
      html: `<div>${escaparHtml(linha)}</div><blockquote>${
        corpoOriginalHtml(o)
      }</blockquote>`,
      texto: `${linha}\n${
        corpoOriginalTexto(o).split("\n").map((l) => `> ${l}`).join("\n")
      }`,
    };
  }
  const cab = [
    "---------- Mensagem encaminhada ----------",
    `De: ${nomeEndereco(o.de)}`,
    ...(data ? [`Data: ${data}`] : []),
    `Assunto: ${o.assunto}`,
    ...(o.para.length ? [`Para: ${o.para.map(nomeEndereco).join(", ")}`] : []),
    ...(o.cc.length ? [`Cc: ${o.cc.map(nomeEndereco).join(", ")}`] : []),
  ];
  return {
    html: `<div>${cab.map(escaparHtml).join("<br>")}</div><br><div>${
      corpoOriginalHtml(o)
    }</div>`,
    texto: `${cab.join("\n")}\n\n${corpoOriginalTexto(o)}`,
  };
}

const EXT_LOGO: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function unicos(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Monta a mensagem MIME completa (bytes) e o envelope SMTP. */
export async function comporMensagem(c: Composicao): Promise<Composta> {
  const corpoHtml = sanitizarHtml(c.html);
  const corpoTexto = c.texto?.trim()
    ? c.texto.replace(/\r\n/g, "\n").trimEnd()
    : htmlParaTexto(corpoHtml);

  const partesHtml = [c.semInvolucro ? corpoHtml : `<div>${corpoHtml}</div>`];
  const partesTexto = [corpoTexto];
  const anexos: Mail.Attachment[] = [];

  if (c.assinatura && !("campos" in c.assinatura)) {
    const a = c.assinatura;
    if (a.html) {
      partesHtml.push(`<div>-- <br>${a.html}</div>`);
      partesTexto.push(`-- \n${a.texto}`);
      for (const i of a.anexosInline) {
        if (!a.html.includes(`cid:${i.cid}`)) continue;
        anexos.push({
          filename: i.nome,
          content: Buffer.from(i.bytes),
          contentType: i.mime,
          cid: i.cid,
          contentDisposition: "inline",
        });
      }
    }
  } else if (c.assinatura) {
    const { campos, logo } = c.assinatura;
    const comLogo = !!(campos.incluirLogo && logo);
    const a = gerarAssinatura(campos, {
      logoCid: comLogo ? CID_LOGO : undefined,
    });
    if (a.html) {
      partesHtml.push(`<div>-- <br>${a.html}</div>`);
      partesTexto.push(`-- \n${a.texto}`);
      if (comLogo && logo && a.html.includes(`cid:${CID_LOGO}`)) {
        anexos.push({
          filename: `logo.${EXT_LOGO[logo.mime] ?? "png"}`,
          content: Buffer.from(logo.bytes),
          contentType: logo.mime,
          cid: CID_LOGO,
          contentDisposition: "inline",
        });
      }
    }
  }

  const orig = c.original;
  if (orig) {
    const q = citacao(orig.modo, orig.msg);
    partesHtml.push(q.html);
    partesTexto.push(q.texto);
  }

  for (const a of c.anexos ?? []) {
    anexos.push({
      filename: nomeArquivo(a.nome),
      content: Buffer.from(a.conteudo),
      contentType: a.tipo || "application/octet-stream",
      contentDisposition: "attachment",
    });
  }

  const dominio = c.de.endereco.split("@")[1] || "localhost";
  const messageId = c.messageId ?? `<${crypto.randomUUID()}@${dominio}>`;
  const assunto = assuntoPadrao(c.assunto, orig?.modo, orig?.msg.assunto ?? "");

  const nome = nomeExibicao(c.de.nome);
  const opcoes: Mail.Options = {
    from: nome ? { name: nome, address: c.de.endereco } : c.de.endereco,
    to: c.para,
    cc: c.cc.length ? c.cc : undefined,
    bcc: c.cco.length ? c.cco : undefined,
    subject: assunto,
    text: partesTexto.join("\n\n"),
    html: partesHtml.join("<br>"),
    attachments: anexos,
    messageId,
    date: c.data ?? new Date(),
  };
  if (c.cabecalhos) {
    opcoes.headers = Object.fromEntries(
      Object.entries(c.cabecalhos).map((
        [k, v],
      ) => [k, v.replace(/[\r\n]+/g, " ")]),
    );
  }
  if (orig?.modo === "resposta" && orig.msg.messageId) {
    opcoes.inReplyTo = orig.msg.messageId;
    opcoes.references = unicos([
      ...orig.msg.references,
      orig.msg.messageId,
    ]).slice(-50);
  }

  const no = new MailComposer(opcoes).compile();
  if (c.manterCco) no.keepBcc = true;
  const raw = await new Promise<Buffer>((res, rej) =>
    no.build((e, b) => e ? rej(e) : res(b))
  );
  return {
    raw: new Uint8Array(raw),
    envelope: {
      from: c.de.endereco,
      to: unicos([...c.para, ...c.cc, ...c.cco]),
    },
    messageId,
    assunto,
  };
}

// ------------------------------------------------------------ transporte

/** Resultado de um envio aceito: destinatários que o servidor recusou. */
export interface Transmitido {
  rejeitados: string[];
}

export type Transmitir = (
  cfg: ConfigMail,
  caixa: CaixaLogin,
  senha: string,
  m: { envelope: { from: string; to: string[] }; raw: Uint8Array },
) => Promise<Transmitido>;

/** `info.rejected` do nodemailer (strings ou {address}) → endereços. */
export function rejeitadosDe(
  info: { rejected?: (string | { name?: string; address?: string })[] },
): string[] {
  return (info.rejected ?? [])
    .map((r) => (typeof r === "string" ? r : r?.address ?? "").toLowerCase())
    .filter(Boolean);
}

/**
 * SMTP real: envia os bytes prontos, sem recompor. Todos recusados → o
 * nodemailer rejeita (EENVELOPE); recusa parcial volta em `rejeitados`.
 */
export const transmitirSmtp: Transmitir = async (cfg, caixa, senha, m) => {
  const t = abrirSmtp(cfg, caixa, senha);
  try {
    const info = await t.sendMail({
      envelope: m.envelope,
      raw: Buffer.from(m.raw),
    });
    return { rejeitados: rejeitadosDe(info) };
  } finally {
    t.close();
  }
};

// fire-and-forget compartilhado com o vigia de caixa (notificar.ts)
export { aguardarNotificacoes } from "../notify/notificar.ts";

/** APPEND em Enviados com \Seen; null se o servidor não tem essa pasta. */
export async function salvarEmEnviados(
  c: ImapFlow,
  raw: Uint8Array,
  data: Date,
): Promise<{ pasta: string; uid: number | null } | null> {
  const enviados = (await listarPastas(c)).find((p) => p.tipo === "enviados");
  if (!enviados) return null;
  const r = await c.append(
    enviados.caminho,
    Buffer.from(raw),
    ["\\Seen"],
    data,
  );
  if (r === false) throw new Error("APPEND recusado");
  return { pasta: enviados.caminho, uid: r.uid ?? null };
}

/** Lê o stream inteiro; passa de `limite` → AnexosGrandesDemais. */
export async function lerAte(s: Readable, limite: number): Promise<Uint8Array> {
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const ch of s) {
      const b = typeof ch === "string" ? Buffer.from(ch) : ch as Uint8Array;
      total += b.length;
      if (total > limite) throw new AnexosGrandesDemais();
      partes.push(b);
    }
  } finally {
    s.destroy();
  }
  return new Uint8Array(Buffer.concat(partes));
}

// ------------------------------------------------------------ envio completo

export interface RefMensagem {
  pasta: string;
  uid: number;
}

export interface PedidoEnvio {
  para: string[];
  cc: string[];
  cco: string[];
  assunto: string;
  html: string;
  texto?: string;
  respondendoA?: RefMensagem;
  encaminhando?: RefMensagem;
  incluirAssinatura: boolean;
  /**
   * 2.0: número → essa assinatura; null → nenhuma; ausente → o padrão de
   * novas ou de respostas/encaminhamentos. `incluirAssinatura: false`
   * (1.0) continua valendo e desliga a assinatura.
   */
  assinaturaId?: number | null;
  anexos: AnexoEnvio[];
}

export interface ResultadoEnvio {
  ok: true;
  messageId: string;
  /** Onde a cópia foi gravada; null se não foi. */
  enviados: { pasta: string; uid: number | null } | null;
  /** Destinatários recusados pelo servidor SMTP (envio parcial). */
  rejeitados: string[];
  /** Enviada, mas algo secundário falhou (recusas parciais, cópia em Enviados). */
  aviso?: string;
}

/**
 * Push de falha do envio: "sempre" (padrão), só em senha recusada
 * ("autenticacao": falhas transitórias vão para a Caixa de saída, que avisa
 * quando desiste) ou "nunca" (o worker da Caixa de saída avisa ele mesmo).
 */
export type PushFalha = "sempre" | "autenticacao" | "nunca";

export interface EnvioDeps {
  sql: Sql;
  masterKey: Uint8Array;
  mail: ConfigMail;
  pool: Pool;
  notificacao: NotificarDeps;
  /** Padrão: transmitirSmtp. */
  transmitir?: Transmitir;
  /** Contas Resend por domínio; ausente → tudo pelo poste.io. */
  resend?: ResendConfig;
  /** Logger de atividade/erro; ausente → não registra. */
  registro?: Registrador;
  agora?: () => Date;
}

function somaAnexos(xs: AnexoEnvio[]): number {
  return xs.reduce((s, a) => s + a.conteudo.length, 0);
}

/**
 * Envia (SMTP), grava em Enviados (APPEND, \Seen), audita e só então
 * dispara os pushes (sem esperar; nunca lançam).
 * Lança CaixaNaoEncontrada, CaixaPrecisaSenha, OriginalNaoEncontrado,
 * AnexosGrandesDemais, FalhaEnvio, ou erros IMAP ao ler o original.
 * Falha no APPEND depois do envio não reenvia: vira `aviso`.
 */
export async function enviarMensagem(
  d: EnvioDeps,
  caixaId: number,
  p: PedidoEnvio,
  opc: { pushFalha?: PushFalha } = {},
): Promise<ResultadoEnvio> {
  const pushFalha = opc.pushFalha ?? "sempre";
  const agora = d.agora ?? (() => new Date());
  const caixa = await obterCaixa(d.sql, caixaId);
  if (!caixa) throw new CaixaNaoEncontrada();
  if (caixa.estado === "precisa_senha") {
    throw new CaixaPrecisaSenha(
      caixa.estado_motivo ? MENSAGEM_SENHA_ILEGIVEL : undefined,
    );
  }
  if (somaAnexos(p.anexos) > LIMITE_ANEXOS) throw new AnexosGrandesDemais();

  // original (resposta/encaminhamento), sem marcar como lida
  const ref = p.respondendoA ?? p.encaminhando;
  const modo: ModoOriginal | undefined = p.respondendoA
    ? "resposta"
    : p.encaminhando
    ? "encaminhamento"
    : undefined;
  let original: Original | undefined;
  const anexos = [...p.anexos];
  if (ref && modo) {
    const lido = await d.pool.comImap(caixaId, async (cli) => {
      const m = await lerMensagem(cli, ref.pasta, ref.uid, {
        marcarLida: false,
      });
      if (!m) return null;
      const encaminhados: AnexoEnvio[] = [];
      if (modo === "encaminhamento") {
        let resta = LIMITE_ANEXOS - somaAnexos(anexos);
        for (const a of m.anexos) {
          const aberto = await abrirAnexo(cli, ref.pasta, ref.uid, a.parte);
          if (!aberto) continue;
          const conteudo = await lerAte(aberto.conteudo, resta);
          resta -= conteudo.length;
          encaminhados.push({
            nome: aberto.nome,
            tipo: aberto.tipo,
            conteudo,
          });
        }
      }
      return { m, encaminhados };
    });
    if (!lido) throw new OriginalNaoEncontrado();
    original = lido.m;
    anexos.push(...lido.encaminhados);
  }

  // assinatura (2.0: escolhida ou padrão do modo; 1.0 como reserva)
  const assinatura: Composicao["assinatura"] = p.incluirAssinatura
    ? await assinaturaParaEnvio(
      d.sql,
      caixa,
      modo ? "resposta" : "nova",
      p.assinaturaId,
    )
    : null;

  const data = agora();
  const m = await comporMensagem({
    de: {
      nome: caixa.nome_exibicao || d.resend?.fromPadrao || "",
      endereco: caixa.endereco,
    },
    para: p.para,
    cc: p.cc,
    cco: p.cco,
    assunto: p.assunto,
    html: p.html,
    texto: p.texto,
    assinatura,
    original: original && modo ? { modo, msg: original } : undefined,
    anexos,
    data,
  });

  // SMTP
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
      { envelope: m.envelope, raw: m.raw },
    ));
  } catch (e) {
    const auth = ehFalhaAutenticacao(e);
    const resumo = resumirErroMail(e);
    console.error(
      "[envio] falha SMTP:",
      (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
    );
    await registro.registrar({
      nivel: "erro",
      area: "envio",
      caixaId,
      mensagem:
        `Falha ao enviar de ${caixa.endereco} via ${alvo.descricao}: ${resumo}`,
      detalhe: { via: alvo.descricao, assunto: m.assunto, auth },
    });
    if (auth) {
      try {
        await marcarPrecisaSenha(d.sql, caixaId, cred.senhaCifrada);
      } catch { /* best-effort */ }
    }
    if (pushFalha === "sempre" || (pushFalha === "autenticacao" && auth)) {
      disparar(notificar("falha", caixaId, {
        titulo: "Falha ao enviar e-mail",
        corpo: `${caixa.endereco}: ${resumo}`,
        url: `/c/${caixaId}`,
        tag: `falha-${caixaId}`,
        ...(caixa.tem_logo ? { icone: `/api/marca/${caixaId}/logo` } : {}),
      }, d.notificacao));
    }
    throw new FalhaEnvio(resumo, auth, !auth && ehRecusaPermanente(e), e);
  }

  await registro.registrar({
    nivel: "info",
    area: "envio",
    caixaId,
    mensagem: `E-mail enviado de ${caixa.endereco} via ${alvo.descricao}`,
    detalhe: {
      via: alvo.descricao,
      assunto: m.assunto,
      destinatarios: m.envelope.to.length,
      ...(rejeitados.length ? { rejeitados: rejeitados.length } : {}),
    },
  });

  // cópia em Enviados (mesmos bytes); falha aqui não reenvia
  let enviados: ResultadoEnvio["enviados"] = null;
  const avisos: string[] = [];
  if (rejeitados.length) {
    avisos.push(
      `O servidor recusou ${rejeitados.length} destinatário${
        rejeitados.length > 1 ? "s" : ""
      }: ${rejeitados.join(", ")}.`,
    );
  }
  try {
    enviados = await d.pool.comImap(
      caixaId,
      (cli) => salvarEmEnviados(cli, m.raw, data),
    );
    if (!enviados) {
      avisos.push(
        "Mensagem enviada, mas a pasta Enviados não foi encontrada no servidor; a cópia não foi salva.",
      );
    }
  } catch (e) {
    console.error(
      "[envio] falha ao gravar em Enviados:",
      (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
    );
    avisos.push(
      `Mensagem enviada, mas a cópia não foi salva em Enviados (${
        e instanceof CaixaPrecisaSenha
          ? "senha recusada no IMAP"
          : resumirErroMail(e)
      }).`,
    );
  }

  try {
    await auditar(d.sql, "usuario", "mensagem_enviada", caixa.endereco, {
      messageId: m.messageId,
      destinatarios: m.envelope.to.length,
      rejeitados,
      anexos: anexos.length,
      modo: modo ?? "nova",
      salvaEmEnviados: !!enviados,
    });
  } catch (e) {
    console.error("[envio] falha ao auditar:", (e as Error)?.name);
  }

  const primeiro = m.envelope.to[0] ?? "";
  const extras = m.envelope.to.length - 1;
  disparar(notificar("enviado", caixaId, {
    titulo: "E-mail enviado",
    corpo: `${m.assunto || "(sem assunto)"} — para ${primeiro}${
      extras > 0 ? ` e mais ${extras}` : ""
    }`,
    url: enviados?.uid
      ? `/c/${caixaId}/m/${encodeURIComponent(enviados.pasta)}/${enviados.uid}`
      : `/c/${caixaId}`,
    tag: `enviado-${caixaId}`,
    ...(caixa.tem_logo ? { icone: `/api/marca/${caixaId}/logo` } : {}),
  }, d.notificacao));

  return {
    ok: true,
    messageId: m.messageId,
    enviados,
    rejeitados,
    ...(avisos.length ? { aviso: avisos.join(" ") } : {}),
  };
}
