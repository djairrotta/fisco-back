// Rascunhos no servidor (pasta Rascunhos/\Drafts): o composer salva com
// APPEND (\Draft \Seen) e apaga a versão anterior, de modo que a cópia do
// servidor é a oficial e aparece também no webmail do poste.io.
//
// O que só o Correio usa (resposta/encaminhamento de qual mensagem e se a
// assinatura entra no envio) vai no cabeçalho X-Correio-Rascunho, em JSON
// base64url. O HTML é só o corpo do editor (sem assinatura nem citação).
import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  abrirAnexo,
  abrirPasta,
  type AnexoDetalhe,
  type Endereco,
  existe,
  lerMensagemCompleta,
  listarPastas,
} from "./leitura.ts";
import {
  type AnexoEnvio,
  AnexosGrandesDemais,
  comporMensagem,
  lerAte,
  LIMITE_ANEXOS,
  type RefMensagem,
} from "./envio.ts";
import { garantirPasta } from "./pastas.ts";

export const CABECALHO_RASCUNHO = "X-Correio-Rascunho";

export class AnexoRascunhoNaoEncontrado extends Error {
  constructor(public parte: string) {
    super(`Anexo ${parte} do rascunho não encontrado`);
    this.name = "AnexoRascunhoNaoEncontrado";
  }
}

export interface MetaRascunho {
  respondendoA?: RefMensagem;
  encaminhando?: RefMensagem;
  incluirAssinatura: boolean;
  /** 2.0: assinatura escolhida no composer (null = nenhuma). */
  assinaturaId?: number | null;
}

const Ref = z.object({
  pasta: z.string().min(1).max(500),
  uid: z.number().int().min(1).max(4294967295),
});
const Meta = z.object({
  respondendoA: Ref.optional(),
  encaminhando: Ref.optional(),
  incluirAssinatura: z.boolean().default(true),
  assinaturaId: z.number().int().min(1).max(999_999_999).nullable()
    .optional(),
});

export function codificarMeta(m: MetaRascunho): string {
  return Buffer.from(JSON.stringify(m), "utf8").toString("base64url");
}

/** Cabeçalho ausente ou ilegível (rascunho do webmail) → sem assinatura extra. */
export function decodificarMeta(v: string | undefined | null): MetaRascunho {
  if (!v) return { incluirAssinatura: false };
  try {
    const j = JSON.parse(
      Buffer.from(v.trim(), "base64url").toString("utf8"),
    );
    const p = Meta.safeParse(j);
    if (p.success) return p.data;
  } catch { /* ignorado */ }
  return { incluirAssinatura: false };
}

export interface DadosRascunho {
  de: Endereco;
  para: string[];
  cc: string[];
  cco: string[];
  assunto: string;
  html: string;
  texto?: string;
  meta: MetaRascunho;
  anexos: AnexoEnvio[];
  data?: Date;
}

/** MIME do rascunho (Bcc mantido, sem assinatura nem citação). */
export async function comporRascunho(
  d: DadosRascunho,
): Promise<{ raw: Uint8Array; messageId: string }> {
  const m = await comporMensagem({
    de: d.de,
    para: d.para,
    cc: d.cc,
    cco: d.cco,
    assunto: d.assunto,
    html: d.html,
    texto: d.texto,
    assinatura: null,
    anexos: d.anexos,
    data: d.data,
    manterCco: true,
    semInvolucro: true,
    cabecalhos: { [CABECALHO_RASCUNHO]: codificarMeta(d.meta) },
  });
  return { raw: m.raw, messageId: m.messageId };
}

/**
 * Baixa as `partes` (IDs IMAP do detalhe) da mensagem `uid` de `pasta` como
 * anexos, somando no máximo `limite` bytes. Parte inexistente →
 * AnexoRascunhoNaoEncontrado.
 */
export async function baixarPartes(
  c: ImapFlow,
  pasta: string,
  uid: number,
  partes: string[],
  limite = LIMITE_ANEXOS,
): Promise<AnexoEnvio[]> {
  const out: AnexoEnvio[] = [];
  let resta = limite;
  for (const parte of [...new Set(partes)]) {
    const a = await abrirAnexo(c, pasta, uid, parte);
    if (!a) throw new AnexoRascunhoNaoEncontrado(parte);
    const conteudo = await lerAte(a.conteudo, resta);
    resta -= conteudo.length;
    if (resta < 0) throw new AnexosGrandesDemais();
    out.push({ nome: a.nome, tipo: a.tipo, conteudo });
  }
  return out;
}

/** Caminho da pasta Rascunhos (criada se o servidor não tem). */
export async function pastaRascunhos(c: ImapFlow): Promise<string> {
  return await garantirPasta(c, "rascunhos", await listarPastas(c));
}

/**
 * Grava o rascunho (APPEND \Draft \Seen) e, com `substituiUid`, apaga a
 * versão anterior depois. Devolve o novo UID (por UIDPLUS ou, sem ele,
 * procurando o Message-ID).
 */
export async function salvarRascunho(
  c: ImapFlow,
  pasta: string,
  raw: Uint8Array,
  messageId: string,
  substituiUid?: number,
): Promise<{ pasta: string; uid: number | null; substituido: boolean }> {
  const r = await c.append(pasta, Buffer.from(raw), ["\\Draft", "\\Seen"]);
  if (r === false) throw new Error("APPEND recusado");
  let uid = r.uid ?? null;
  await abrirPasta(c, pasta, false);
  if (uid === null) {
    const achados = (await c.search({ header: { "message-id": messageId } }, {
      uid: true,
    })) || [];
    uid = achados.length ? Math.max(...achados) : null;
  }
  let substituido = false;
  if (substituiUid && substituiUid !== uid && await existe(c, substituiUid)) {
    substituido = await c.messageDelete(String(substituiUid), { uid: true });
  }
  return { pasta, uid, substituido };
}

/** Apaga (expurga) o rascunho `uid` da pasta Rascunhos. false se não existe. */
export async function apagarRascunho(
  c: ImapFlow,
  uid: number,
  pasta?: string,
): Promise<boolean> {
  const p = pasta ?? await pastaRascunhos(c);
  await abrirPasta(c, p, false);
  if (!(await existe(c, uid))) return false;
  return await c.messageDelete(String(uid), { uid: true });
}

export interface Rascunho {
  uid: number;
  pasta: string;
  para: Endereco[];
  cc: Endereco[];
  cco: Endereco[];
  assunto: string;
  html: string | null;
  texto: string | null;
  respondendoA: RefMensagem | null;
  encaminhando: RefMensagem | null;
  incluirAssinatura: boolean;
  /** 2.0: ausente = padrão do modo; null = nenhuma. */
  assinaturaId?: number | null;
  anexos: AnexoDetalhe[];
  data: string | null;
}

/** Lê o rascunho para reabrir o composer (não altera flags). */
export async function lerRascunho(
  c: ImapFlow,
  uid: number,
): Promise<Rascunho | null> {
  const pasta = await pastaRascunhos(c);
  const r = await lerMensagemCompleta(c, pasta, uid, { marcarLida: false });
  if (!r) return null;
  const { mensagem: m, email } = r;
  const cab = email.headers.find((h) =>
    h.key.toLowerCase() === CABECALHO_RASCUNHO.toLowerCase()
  )?.value;
  const meta = decodificarMeta(cab);
  const cco: Endereco[] = [];
  for (const a of email.bcc ?? []) {
    if ("group" in a && a.group) {
      for (const g of a.group) {
        cco.push({ nome: g.name ?? "", endereco: g.address ?? "" });
      }
    } else cco.push({ nome: a.name ?? "", endereco: a.address ?? "" });
  }
  return {
    uid,
    pasta,
    para: m.para,
    cc: m.cc,
    cco,
    assunto: m.assunto,
    html: m.html,
    texto: m.texto,
    respondendoA: meta.respondendoA ?? null,
    encaminhando: meta.encaminhando ?? null,
    incluirAssinatura: meta.incluirAssinatura,
    ...(meta.assinaturaId !== undefined
      ? { assinaturaId: meta.assinaturaId }
      : {}),
    anexos: m.anexos,
    data: m.data,
  };
}
