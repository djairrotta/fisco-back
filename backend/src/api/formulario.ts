// Leitura e validação dos campos multipart do composer (envio e rascunho).
import { z } from "zod";
import {
  type AnexoEnvio,
  dividirEnderecos,
  LIMITE_ANEXOS,
  MAX_DESTINATARIOS,
  nomeArquivo,
  type RefMensagem,
} from "../mail/envio.ts";

export const MAX_HTML = 512 * 1024;
export const MAX_TEXTO = 512 * 1024;
export const MAX_ASSUNTO = 998;
export const MAX_ARQUIVOS = 50;
export const MAX_UID = 4294967295;

// deno-lint-ignore no-control-regex
export const CONTROLE = /[\x00-\x1f\x7f]/;

/** Erro de validação → 400 {erro}. */
export class Invalido extends Error {}

export const Ref = z.object({
  pasta: z.string().min(1).max(500).refine((s) => !CONTROLE.test(s)),
  uid: z.number().int().min(1).max(MAX_UID),
});

export type Valor = string | File | (string | File)[] | undefined;
export type Formulario = Record<string, Valor>;

export function texto(v: Valor, nome: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Invalido(`Campo ${nome} inválido`);
  if (v.length > max) throw new Invalido(`Campo ${nome} longo demais`);
  return v;
}

function json(v: Valor, nome: string, max = 1000): unknown {
  const s = texto(v, nome, max);
  if (s === undefined || s === "") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    throw new Invalido(`Campo ${nome} inválido`);
  }
}

export function ref(v: Valor, nome: string): RefMensagem | undefined {
  const bruto = json(v, nome);
  if (bruto === undefined) return undefined;
  const p = Ref.safeParse(bruto);
  if (!p.success) throw new Invalido(`Campo ${nome} inválido`);
  return p.data;
}

export function booleano(v: Valor, nome: string, padrao: boolean): boolean {
  const s = texto(v, nome, 10);
  if (s === undefined || s === "") return padrao;
  if (/^(true|1|on)$/i.test(s)) return true;
  if (/^(false|0|off)$/i.test(s)) return false;
  throw new Invalido(`Campo ${nome} inválido`);
}

export function enderecos(v: Valor, nome: string): string[] {
  const r = dividirEnderecos(texto(v, nome, 20_000));
  if (!r.ok) throw new Invalido(`Endereço inválido em ${nome}: ${r.invalido}`);
  return r.enderecos;
}

/**
 * assinaturaId do composer: ausente ou "" → undefined (padrão do modo);
 * "null" / "nenhuma" → null (sem assinatura); número → essa assinatura.
 */
export function assinaturaIdDe(
  v: Valor,
  nome = "assinaturaId",
): number | null | undefined {
  const s = texto(v, nome, 12)?.trim();
  if (s === undefined || s === "") return undefined;
  if (/^(null|nenhuma)$/i.test(s)) return null;
  if (!/^\d{1,9}$/.test(s) || Number(s) < 1) {
    throw new Invalido(`Campo ${nome} inválido`);
  }
  return Number(s);
}

/** UID opcional (número decimal). */
export function uidOpcional(v: Valor, nome: string): number | undefined {
  const s = texto(v, nome, 12);
  if (s === undefined || s === "") return undefined;
  const n = /^\d{1,10}$/.test(s) ? Number(s) : 0;
  if (n < 1 || n > MAX_UID) throw new Invalido(`Campo ${nome} inválido`);
  return n;
}

/** Lista JSON de partes IMAP ("2", "1.2.2") dos anexos de um rascunho. */
export function partes(v: Valor, nome: string): string[] {
  const bruto = json(v, nome, 4000);
  if (bruto === undefined) return [];
  const p = z.array(z.string().max(40).regex(/^\d+(\.\d+)*$/)).max(
    MAX_ARQUIVOS,
  ).safeParse(bruto);
  if (!p.success) throw new Invalido(`Campo ${nome} inválido`);
  return p.data;
}

/** Data/hora ISO 8601 (com fuso) opcional. */
export function dataHora(v: Valor, nome: string): Date | undefined {
  const s = texto(v, nome, 40);
  if (s === undefined || s === "") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    throw new Invalido(`Campo ${nome} inválido (use ISO 8601)`);
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Invalido(`Campo ${nome} inválido`);
  return d;
}

export function arquivos(form: Formulario): File[] {
  const out: File[] = [];
  for (const k of ["files[]", "files"]) {
    const v = form[k];
    const xs = v === undefined ? [] : Array.isArray(v) ? v : [v];
    for (const x of xs) {
      if (x instanceof File) out.push(x);
      else throw new Invalido("Anexo inválido");
    }
  }
  if (out.length > MAX_ARQUIVOS) {
    throw new Invalido(`No máximo ${MAX_ARQUIVOS} anexos por mensagem`);
  }
  return out;
}

export function somaArquivos(fs: File[]): number {
  return fs.reduce((s, f) => s + f.size, 0);
}

export async function anexosDe(fs: File[]): Promise<AnexoEnvio[]> {
  const out: AnexoEnvio[] = [];
  for (const f of fs) {
    out.push({
      nome: nomeArquivo(f.name),
      tipo: f.type || "application/octet-stream",
      conteudo: new Uint8Array(await f.arrayBuffer()),
    });
  }
  return out;
}

export interface CamposComposer {
  para: string[];
  cc: string[];
  cco: string[];
  assunto: string;
  html: string;
  texto?: string;
  respondendoA?: RefMensagem;
  encaminhando?: RefMensagem;
  incluirAssinatura: boolean;
  /** Ver assinaturaIdDe; ausente = padrão do modo. */
  assinaturaId?: number | null;
}

/** Campos comuns a envio e rascunho; `exigirDestinatario` só no envio. */
export function camposComposer(
  form: Formulario,
  exigirDestinatario: boolean,
): CamposComposer {
  const para = enderecos(form.para, "para");
  const cc = enderecos(form.cc, "cc");
  const cco = enderecos(form.cco, "cco");
  const total = new Set([...para, ...cc, ...cco]).size;
  if (exigirDestinatario && total === 0) {
    throw new Invalido("Informe ao menos um destinatário");
  }
  if (total > MAX_DESTINATARIOS) {
    throw new Invalido(
      `No máximo ${MAX_DESTINATARIOS} destinatários por mensagem`,
    );
  }
  const respondendoA = ref(form.respondendoA, "respondendoA");
  const encaminhando = ref(form.encaminhando, "encaminhando");
  if (respondendoA && encaminhando) {
    throw new Invalido("Escolha responder ou encaminhar, não os dois");
  }
  const assinaturaId = assinaturaIdDe(form.assinaturaId);
  return {
    para,
    cc,
    cco,
    assunto: texto(form.assunto, "assunto", MAX_ASSUNTO) ?? "",
    html: texto(form.html, "html", MAX_HTML) ?? "",
    texto: texto(form.texto, "texto", MAX_TEXTO),
    respondendoA,
    encaminhando,
    incluirAssinatura: booleano(
      form.incluirAssinatura,
      "incluirAssinatura",
      true,
    ),
    ...(assinaturaId !== undefined ? { assinaturaId } : {}),
  };
}

export { LIMITE_ANEXOS };
