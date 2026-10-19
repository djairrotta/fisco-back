// Leitura de e-mail via IMAP: pastas, lista paginada com busca, detalhe
// (postal-mime para corpo/cabeçalhos), anexos pela BODYSTRUCTURE por streaming e ações (lida, mover, lixeira).
//
// As funções recebem um ImapFlow já autenticado (veja pool.ts) e não fazem
// logout. O HTML das mensagens sai BRUTO: quem sanitiza é o PWA (DOMPurify +
// iframe sandbox).
import type {
  FetchMessageObject,
  ImapFlow,
  MessageAddressObject,
  MessageStructureObject,
} from "imapflow";
import { Buffer } from "node:buffer";
import { Readable, Transform } from "node:stream";
import PostalMime, { type Address, type Email } from "postal-mime";
import { previas } from "./previa.ts";

// ------------------------------------------------------------ erros

export class PastaNaoEncontrada extends Error {
  constructor() {
    super("Pasta não encontrada");
    this.name = "PastaNaoEncontrada";
  }
}

export class MensagemGrandeDemais extends Error {
  constructor(public limiteBytes: number) {
    super(
      `Mensagem grande demais para abrir aqui (mais de ${
        Math.round(limiteBytes / 1048576)
      } MB).`,
    );
    this.name = "MensagemGrandeDemais";
  }
}

export class SemLixeira extends Error {
  constructor() {
    super("Pasta Lixeira não encontrada no servidor");
    this.name = "SemLixeira";
  }
}

// ------------------------------------------------------------ pastas

export type TipoPasta =
  | "entrada"
  | "enviados"
  | "lixeira"
  | "spam"
  | "rascunhos"
  | "arquivo";

export interface Pasta {
  /** Caminho IMAP (use em `pasta=` e `destino`). */
  caminho: string;
  /** Nome para exibir: pt-BR para as especiais, senão o caminho legível. */
  nome: string;
  tipo: TipoPasta | null;
  /** true quando o tipo veio de flag SPECIAL-USE do servidor. */
  porFlag: boolean;
  /** Separador de níveis do servidor ("." ou "/"). */
  delimitador?: string;
  /** Mensagens na pasta (STATUS), quando pedido em listarPastas. */
  total?: number | null;
  /** Não lidas (STATUS UNSEEN), quando pedido em listarPastas. */
  naoLidas?: number | null;
}

export const NOMES_TIPO: Record<TipoPasta, string> = {
  entrada: "Entrada",
  enviados: "Enviados",
  lixeira: "Lixeira",
  spam: "Spam",
  rascunhos: "Rascunhos",
  arquivo: "Arquivo",
};

/** Flag SPECIAL-USE (RFC 6154) de cada tipo. */
export const SPECIAL_USE: Record<TipoPasta, string> = {
  entrada: "\\Inbox",
  enviados: "\\Sent",
  lixeira: "\\Trash",
  spam: "\\Junk",
  rascunhos: "\\Drafts",
  arquivo: "\\Archive",
};

/** Ordem da barra lateral: Entrada, Rascunhos, Enviados, Arquivo, Spam, Lixeira. */
const ORDEM_TIPO: TipoPasta[] = [
  "entrada",
  "rascunhos",
  "enviados",
  "arquivo",
  "spam",
  "lixeira",
];

const POR_FLAG: Record<string, TipoPasta> = {
  "\\sent": "enviados",
  "\\trash": "lixeira",
  "\\junk": "spam",
  "\\drafts": "rascunhos",
  "\\archive": "arquivo",
};

const POR_NOME: Record<string, TipoPasta> = {};
for (
  const [tipo, nomes] of [
    ["enviados", [
      "sent",
      "sent items",
      "sent messages",
      "sent mail",
      "enviados",
      "enviadas",
      "itens enviados",
    ]],
    ["lixeira", [
      "trash",
      "deleted",
      "deleted items",
      "deleted messages",
      "lixeira",
      "lixo",
    ]],
    ["spam", [
      "junk",
      "spam",
      "junk e-mail",
      "junk email",
      "bulk mail",
      "lixo eletrônico",
    ]],
    ["rascunhos", ["drafts", "draft", "rascunhos", "rascunho"]],
    // só os nomes exatos; outros nomes só pela flag \Archive
    ["arquivo", ["archive", "archives", "arquivo"]],
  ] as [TipoPasta, string[]][]
) {
  for (const n of nomes) POR_NOME[n] = tipo;
}

interface PastaImap {
  path: string;
  name: string;
  delimiter?: string;
  flags: Set<string>;
  specialUse?: string;
}

const ehInbox = (path: string) => path.toUpperCase() === "INBOX";

function semPrefixoInbox(path: string): string {
  return path.replace(/^INBOX[./]/i, "");
}

/**
 * Tipo da pasta: INBOX; flag SPECIAL-USE (\Sent, \Trash, \Junk, \Drafts);
 * nome (Sent, Trash, Junk, Spam, Drafts…, inclusive INBOX.*); por último a
 * heurística de nomes do imapflow.
 */
export function tipoPasta(p: PastaImap): TipoPasta | null {
  if (ehInbox(p.path)) return "entrada";
  for (const f of p.flags) {
    const t = POR_FLAG[f.toLowerCase()];
    if (t) return t;
  }
  const t = POR_NOME[semPrefixoInbox(p.path).toLowerCase().trim()];
  if (t) return t;
  if (p.specialUse) {
    const s = p.specialUse.toLowerCase();
    if (s === "\\inbox") return null; // só a INBOX de verdade é Entrada
    return POR_FLAG[s] ?? null;
  }
  return null;
}

function temFlagEspecial(p: PastaImap): boolean {
  for (const f of p.flags) if (POR_FLAG[f.toLowerCase()]) return true;
  return false;
}

/** A pasta do tipo; flag do servidor vence correspondência por nome. */
export function acharPasta(
  pastas: Pasta[],
  tipo: TipoPasta,
): Pasta | undefined {
  const doTipo = pastas.filter((p) => p.tipo === tipo);
  return doTipo.find((p) => p.porFlag) ?? doTipo[0];
}

/**
 * Pastas selecionáveis. Cada tipo fica em uma só pasta (as demais
 * candidatas viram pastas comuns). Ordem: Entrada, Rascunhos, Enviados,
 * Arquivo, Spam, Lixeira, depois as outras em ordem alfabética.
 * Com `contagens`, cada pasta traz `total` e `naoLidas` (LIST-STATUS ou
 * STATUS por pasta; null se o servidor não informar).
 */
export async function listarPastas(
  c: ImapFlow,
  opc: { contagens?: boolean } = {},
): Promise<Pasta[]> {
  const lista = await c.list(
    opc.contagens
      ? { statusQuery: { messages: true, unseen: true } }
      : undefined,
  );
  const brutas = lista.filter((p) => {
    for (const f of p.flags) {
      const l = f.toLowerCase();
      if (l === "\\noselect" || l === "\\nonexistent") return false;
    }
    return true;
  });
  const todas: Pasta[] = brutas.map((p) => {
    const tipo = tipoPasta(p);
    const pasta: Pasta = {
      caminho: p.path,
      nome: legivel(p),
      tipo,
      porFlag: tipo !== null && temFlagEspecial(p),
      delimitador: p.delimiter || "/",
    };
    if (opc.contagens) {
      pasta.total = p.status?.messages ?? null;
      pasta.naoLidas = p.status?.unseen ?? null;
    }
    return pasta;
  });
  const escolhidas = new Set<Pasta>();
  for (const t of ORDEM_TIPO) {
    const p = acharPasta(todas, t);
    if (p) escolhidas.add(p);
  }
  for (const p of todas) {
    if (escolhidas.has(p)) p.nome = NOMES_TIPO[p.tipo!];
    else if (p.tipo) {
      p.tipo = null;
      p.porFlag = false;
    }
  }
  const pos = (p: Pasta) => p.tipo ? ORDEM_TIPO.indexOf(p.tipo) : 99;
  return todas.sort((a, b) =>
    pos(a) - pos(b) || a.nome.localeCompare(b.nome, "pt-BR")
  );
}

function legivel(p: PastaImap): string {
  const d = p.delimiter || "/";
  return semPrefixoInbox(p.path).split(d).filter(Boolean).join(" / ") ||
    p.name;
}

/** Seleciona a pasta; NO do servidor (não existe) vira PastaNaoEncontrada. */
export async function abrirPasta(
  c: ImapFlow,
  pasta: string,
  readOnly: boolean,
): Promise<void> {
  try {
    await c.mailboxOpen(pasta, { readOnly });
  } catch (e) {
    const x = e as { responseStatus?: string; serverResponseCode?: string };
    if (x?.responseStatus === "NO" || x?.serverResponseCode === "NONEXISTENT") {
      throw new PastaNaoEncontrada();
    }
    throw e;
  }
}

// ------------------------------------------------------------ anexos (estrutura)

export interface ParteAnexo {
  /** Parte IMAP (ex.: "2", "1.2.2"): identifica o anexo no detalhe e no download. */
  parte: string;
  nome: string | null;
  tipo: string;
  /** Bytes decodificados, estimados pela BODYSTRUCTURE. */
  tamanho: number;
  /** Content-ID sem <>, para trocar `cid:` por blob no PWA. */
  cid: string | null;
  /** Content-Transfer-Encoding (minúsculo) quando base64/quoted-printable. */
  codificacao: string | null;
}

const semColchetes = (s?: string | null) =>
  s ? s.trim().replace(/^<|>$/g, "") || null : null;

/** Tamanho decodificado aproximado a partir do tamanho codificado. */
function estimarTamanho(tamanho: number, cod: string | null): number {
  if (cod !== "base64") return tamanho;
  // linhas de 76 caracteres + CRLF
  const dados = tamanho - Math.floor(tamanho / 78) * 2;
  return Math.floor(dados * 3 / 4);
}

/**
 * Fonte ÚNICA dos anexos (detalhe e download): folhas da BODYSTRUCTURE, em
 * ordem, exceto text/plain e text/html que são corpo (sem disposition
 * attachment e sem nome de arquivo). message/rfc822 é uma folha (baixa o
 * .eml inteiro).
 */
export function partesAnexo(raiz: MessageStructureObject): ParteAnexo[] {
  const out: ParteAnexo[] = [];
  const andar = (n: MessageStructureObject) => {
    const tipo = (n.type || "application/octet-stream").toLowerCase();
    if (tipo.startsWith("multipart/")) {
      for (const f of n.childNodes ?? []) andar(f);
      return;
    }
    const disp = n.disposition?.toLowerCase();
    const nome = n.dispositionParameters?.filename ?? n.parameters?.name ??
      null;
    if (
      disp !== "attachment" && !nome &&
      (tipo === "text/plain" || tipo === "text/html")
    ) return;
    const codificacao = codificacaoConhecida(n.encoding);
    out.push({
      parte: n.part ?? "1",
      nome,
      tipo,
      tamanho: estimarTamanho(n.size ?? 0, codificacao),
      cid: semColchetes(n.id),
      codificacao,
    });
  };
  andar(raiz);
  return out;
}

function codificacaoConhecida(e?: string): string | null {
  const x = e?.toLowerCase().trim();
  return x === "base64" || x === "quoted-printable" ? x : null;
}

/**
 * Decodificador em streaming de base64/quoted-printable (null para as
 * demais). Usado quando o servidor devolve um cabeçalho MIME de parte que
 * não confere com a BODYSTRUCTURE e o imapflow entrega a parte codificada.
 */
export function decodificador(encoding?: string): Transform | null {
  const cod = codificacaoConhecida(encoding);
  if (cod === "base64") {
    let resto = "";
    return new Transform({
      transform(ch: Buffer, _enc, cb) {
        const s = resto + ch.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
        const n = s.length - (s.length % 4);
        resto = s.slice(n);
        cb(null, Buffer.from(s.slice(0, n), "base64"));
      },
      flush(cb) {
        cb(null, resto ? Buffer.from(resto, "base64") : undefined);
      },
    });
  }
  if (cod === "quoted-printable") {
    let resto = "";
    const decodificar = (s: string) => {
      const out: number[] = [];
      for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        if (ch !== 0x3d) {
          out.push(ch);
          continue;
        }
        const h = s.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(h)) {
          out.push(parseInt(h, 16));
          i += 2;
        } else if (h.startsWith("\r\n")) i += 2;
        else if (h.startsWith("\n")) i += 1;
        // "=" final ou inválido: descartado
      }
      return Buffer.from(out);
    };
    return new Transform({
      transform(ch: Buffer, _enc, cb) {
        const s = resto + ch.toString("latin1");
        // guarda um "=" incompleto no fim para o próximo pedaço
        const k = s.lastIndexOf("=");
        const corte = k >= 0 && k > s.length - 3 ? k : s.length;
        resto = s.slice(corte);
        cb(null, decodificar(s.slice(0, corte)));
      },
      flush(cb) {
        cb(null, decodificar(resto));
      },
    });
  }
  return null;
}

/** Content-Disposition de download, com filename* (RFC 5987). */
export function cabecalhoDisposicao(nomeBruto: string): string {
  // surrogate solto faria encodeURIComponent lançar URIError
  const nome = nomeBruto.toWellFormed();
  const ascii = nome.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  const utf8 = encodeURIComponent(nome).replace(
    /['()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

const TIPOS_SEGUROS = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

/** Só imagem raster e PDF mantêm o tipo; o resto vai como octet-stream. */
export function tipoDownload(tipo: string): string {
  const t = tipo.toLowerCase().trim();
  return TIPOS_SEGUROS.has(t) ? t : "application/octet-stream";
}

// ------------------------------------------------------------ lista

export const POR_PAGINA = 50;

export interface Endereco {
  nome: string;
  endereco: string;
}

export interface ItemLista {
  uid: number;
  de: Endereco | null;
  assunto: string;
  /** ISO 8601 (Date do cabeçalho; sem ela, a data de chegada). */
  data: string | null;
  lida: boolean;
  /** \\Flagged (favorito). */
  estrela: boolean;
  temAnexo: boolean;
  tamanho: number;
  /** ~160 caracteres do corpo em texto ("" se não há parte de texto). */
  previa: string;
}

export interface PaginaMensagens {
  mensagens: ItemLista[];
  pagina: number;
  porPagina: number;
  total: number;
}

function endereco(a?: MessageAddressObject): Endereco | null {
  if (!a) return null;
  return { nome: a.name ?? "", endereco: a.address ?? "" };
}

function iso(d: unknown): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(String(d));
  return isNaN(x.getTime()) ? null : x.toISOString();
}

export function item(m: FetchMessageObject, previa = ""): ItemLista {
  return {
    uid: m.uid,
    de: endereco(m.envelope?.from?.[0]),
    assunto: m.envelope?.subject ?? "",
    data: iso(m.envelope?.date) ?? iso(m.internalDate),
    lida: m.flags?.has("\\Seen") ?? false,
    estrela: m.flags?.has("\\Flagged") ?? false,
    temAnexo: m.bodyStructure ? partesAnexo(m.bodyStructure).length > 0 : false,
    tamanho: m.size ?? 0,
    previa,
  };
}

/** Itens da lista com prévia (trechos parciais, BODY.PEEK). */
export async function itensComPrevia(
  c: ImapFlow,
  pasta: string,
  msgs: FetchMessageObject[],
): Promise<ItemLista[]> {
  const pv = await previas(c, pasta, msgs);
  return msgs.map((m) => item(m, pv.get(m.uid) ?? ""));
}

export const CONSULTA_LISTA = {
  uid: true,
  envelope: true,
  flags: true,
  size: true,
  bodyStructure: true,
  internalDate: true,
} as const;

/**
 * Até 50 mensagens, mais novas primeiro. Com `busca`: IMAP SEARCH
 * OR (FROM, SUBJECT, BODY).
 */
export async function listarMensagens(
  c: ImapFlow,
  pasta: string,
  opc: { pagina?: number; busca?: string } = {},
): Promise<PaginaMensagens> {
  const pagina = Math.max(1, opc.pagina ?? 1);
  await abrirPasta(c, pasta, true);
  const base = { pagina, porPagina: POR_PAGINA };
  let msgs: FetchMessageObject[] = [];
  let total: number;

  const busca = opc.busca?.trim();
  if (busca) {
    const uids = (await c.search({
      or: [{ from: busca }, { subject: busca }, { body: busca }],
    }, { uid: true })) || [];
    uids.sort((a, b) => b - a);
    total = uids.length;
    const fatia = uids.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
    if (fatia.length) {
      msgs = await coletar(c, fatia.join(","), true);
    }
  } else {
    total = c.mailbox ? c.mailbox.exists : 0;
    const fim = total - (pagina - 1) * POR_PAGINA;
    if (fim >= 1) {
      const ini = Math.max(1, fim - POR_PAGINA + 1);
      msgs = await coletar(c, `${ini}:${fim}`, false);
    }
  }
  msgs.sort((a, b) => b.uid - a.uid);
  return { ...base, total, mensagens: await itensComPrevia(c, pasta, msgs) };
}

export async function coletar(
  c: ImapFlow,
  faixa: string,
  uid: boolean,
): Promise<FetchMessageObject[]> {
  const out: FetchMessageObject[] = [];
  for await (const m of c.fetch(faixa, CONSULTA_LISTA, { uid })) out.push(m);
  return out;
}

// ------------------------------------------------------------ detalhe

export const LIMITE_MENSAGEM = 50 * 1024 * 1024;

/** Anexo no detalhe: o mesmo objeto que o download resolve por `parte`. */
export type AnexoDetalhe = Omit<ParteAnexo, "codificacao">;

export interface MensagemDetalhe {
  uid: number;
  pasta: string;
  de: Endereco | null;
  para: Endereco[];
  cc: Endereco[];
  responderPara: Endereco[];
  assunto: string;
  data: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** HTML BRUTO (o PWA sanitiza). */
  html: string | null;
  texto: string | null;
  anexos: AnexoDetalhe[];
  lida: boolean;
  /** \\Flagged (favorito). */
  estrela: boolean;
  tamanho: number;
  /**
   * Selo do classificador: presente quando a classe não é ok e a confiança
   * é ≥ 0,7 (preenchido pela rota); null sem veredito ou sem suspeita.
   */
  suspeita: Suspeita | null;
}

export interface Suspeita {
  classe: "spam" | "phishing";
  confianca: number;
  motivo: string;
}

function planos(lista?: Address[] | Address): Endereco[] {
  const out: Endereco[] = [];
  const arr = lista === undefined ? [] : Array.isArray(lista) ? lista : [lista];
  for (const a of arr) {
    if ("group" in a && a.group) {
      for (const m of a.group) {
        out.push({ nome: m.name ?? "", endereco: m.address ?? "" });
      }
    } else out.push({ nome: a.name ?? "", endereco: a.address ?? "" });
  }
  return out;
}

/**
 * Busca e interpreta a mensagem (até `limiteBytes`, padrão 50 MB) e a
 * marca como lida (exceto com `marcarLida: false`, usado ao responder ou
 * encaminhar). null se o UID não existe na pasta.
 */
export async function lerMensagem(
  c: ImapFlow,
  pasta: string,
  uid: number,
  opc: { limiteBytes?: number; marcarLida?: boolean } = {},
): Promise<MensagemDetalhe | null> {
  return (await lerMensagemCompleta(c, pasta, uid, opc))?.mensagem ?? null;
}

/** Como lerMensagem, devolvendo também a mensagem interpretada (classificador). */
export async function lerMensagemCompleta(
  c: ImapFlow,
  pasta: string,
  uid: number,
  opc: { limiteBytes?: number; marcarLida?: boolean } = {},
): Promise<
  { mensagem: MensagemDetalhe; email: Email; uidValidity: string } | null
> {
  const limite = opc.limiteBytes ?? LIMITE_MENSAGEM;
  const marcar = opc.marcarLida !== false;
  await abrirPasta(c, pasta, !marcar);
  const uidValidity = String(c.mailbox ? c.mailbox.uidValidity : "");
  const info = await c.fetchOne(String(uid), {
    uid: true,
    size: true,
    flags: true,
    bodyStructure: true,
  }, { uid: true });
  if (!info) return null;
  if ((info.size ?? 0) > limite) throw new MensagemGrandeDemais(limite);
  const msg = await c.fetchOne(String(uid), { uid: true, source: true }, {
    uid: true,
  });
  if (!msg || !msg.source) return null;

  // postal-mime só para html/texto e cabeçalhos; anexos vêm da BODYSTRUCTURE
  const email = await PostalMime.parse(msg.source, {
    forceRfc822Attachments: true,
  });
  const anexos: AnexoDetalhe[] = info.bodyStructure
    ? partesAnexo(info.bodyStructure).map(({ codificacao: _, ...a }) => a)
    : [];

  if (marcar && !info.flags?.has("\\Seen")) {
    await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
  }

  const mensagem: MensagemDetalhe = {
    uid,
    pasta,
    de: planos(email.from)[0] ?? null,
    para: planos(email.to),
    cc: planos(email.cc),
    responderPara: planos(email.replyTo),
    assunto: email.subject ?? "",
    data: iso(email.date),
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: (email.references ?? "").split(/\s+/).filter(Boolean),
    html: email.html ?? null,
    texto: email.text ?? null,
    anexos,
    lida: marcar || !!info.flags?.has("\\Seen"),
    estrela: !!info.flags?.has("\\Flagged"),
    tamanho: info.size ?? 0,
    suspeita: null,
  };
  return { mensagem, email, uidValidity };
}

// ------------------------------------------------------------ download

export interface AnexoAberto {
  nome: string;
  tipo: string;
  /** Conteúdo decodificado, em streaming do IMAP. */
  conteudo: Readable;
}

/**
 * Abre o anexo da `parte` IMAP (a mesma do detalhe) como stream; só partes
 * listadas por partesAnexo (nunca o corpo). A conexão
 * precisa ficar aberta até o stream terminar. null se não existe.
 */
export async function abrirAnexo(
  c: ImapFlow,
  pasta: string,
  uid: number,
  parte: string,
): Promise<AnexoAberto | null> {
  await abrirPasta(c, pasta, true);
  const info = await c.fetchOne(String(uid), {
    uid: true,
    bodyStructure: true,
  }, { uid: true });
  if (!info || !info.bodyStructure) return null;
  const p = partesAnexo(info.bodyStructure).find((x) => x.parte === parte);
  if (!p) return null;
  let dl;
  try {
    dl = await c.download(String(uid), p.parte, { uid: true });
  } catch (e) {
    // Alguns servidores (GreenMail) recusam BODY[n] de message/rfc822;
    // HEADER + TEXT da parte reconstituem o .eml (em memória, com limite).
    const x = e as { responseStatus?: string };
    if (p.tipo !== "message/rfc822" || x?.responseStatus !== "NO") throw e;
    return await emlPorPartes(c, uid, p);
  }
  if (!dl.content) return null;
  let conteudo: Readable = dl.content;
  // Sem `encoding` no meta, o imapflow não decodificou (cabeçalho MIME da
  // parte veio errado — o GreenMail faz isso em partes aninhadas).
  const dec = dl.meta.encoding ? null : decodificador(p.codificacao ?? "");
  if (dec) {
    conteudo = dl.content.pipe(dec);
    dl.content.on("error", (e) => dec.destroy(e));
    dec.on("close", () => dl.content.destroy());
  }
  return {
    nome: p.nome || dl.meta.filename ||
      (p.tipo === "message/rfc822"
        ? `mensagem-${parte}.eml`
        : `anexo-${parte}`),
    tipo: p.tipo,
    conteudo,
  };
}

async function emlPorPartes(
  c: ImapFlow,
  uid: number,
  p: ParteAnexo,
): Promise<AnexoAberto | null> {
  if (p.tamanho > LIMITE_MENSAGEM) {
    throw new MensagemGrandeDemais(LIMITE_MENSAGEM);
  }
  const h = `${p.parte}.HEADER`, t = `${p.parte}.TEXT`;
  const r = await c.fetchOne(String(uid), { uid: true, bodyParts: [h, t] }, {
    uid: true,
  });
  const partes = r ? r.bodyParts : undefined;
  const cab = partes?.get(h.toLowerCase());
  const txt = partes?.get(t.toLowerCase());
  if (!cab || !txt) return null;
  // o cabeçalho deve terminar com a linha em branco
  const sep = cab.subarray(-4).toString("latin1") === "\r\n\r\n"
    ? ""
    : cab.subarray(-2).toString("latin1") === "\r\n"
    ? "\r\n"
    : "\r\n\r\n";
  return {
    nome: p.nome || `mensagem-${p.parte}.eml`,
    tipo: p.tipo,
    conteudo: Readable.from([Buffer.concat([cab, Buffer.from(sep), txt])]),
  };
}

// ------------------------------------------------------------ ações

export async function existe(c: ImapFlow, uid: number): Promise<boolean> {
  return !!(await c.fetchOne(String(uid), { uid: true }, { uid: true }));
}

/** Marca/desmarca \Seen. false se a mensagem não existe. */
export async function marcarLida(
  c: ImapFlow,
  pasta: string,
  uid: number,
  lida: boolean,
): Promise<boolean> {
  await abrirPasta(c, pasta, false);
  if (!(await existe(c, uid))) return false;
  if (lida) await c.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
  else await c.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
  return true;
}

/**
 * Move para `destino` (deve existir). null se a mensagem não existe;
 * `uid` é o novo UID quando o servidor informa (UIDPLUS).
 */
export async function moverMensagem(
  c: ImapFlow,
  pasta: string,
  uid: number,
  destino: string,
): Promise<{ uid: number | null } | null> {
  await abrirPasta(c, pasta, false);
  if (!(await existe(c, uid))) return null;
  const r = await c.messageMove(String(uid), destino, { uid: true });
  if (!r) throw new Error("MOVE recusado");
  return { uid: r.uidMap?.get(uid) ?? null };
}

/**
 * Fora da Lixeira: move para ela. Na Lixeira: apaga e expurga.
 * null se a mensagem não existe.
 */
export async function apagarMensagem(
  c: ImapFlow,
  pasta: string,
  uid: number,
): Promise<"lixeira" | "apagada" | null> {
  const lixeira = acharPasta(await listarPastas(c), "lixeira");
  const naLixeira = lixeira !== undefined &&
    (lixeira.caminho === pasta ||
      (ehInbox(lixeira.caminho) && ehInbox(pasta)));
  if (naLixeira) {
    await abrirPasta(c, pasta, false);
    if (!(await existe(c, uid))) return null;
    if (!(await c.messageDelete(String(uid), { uid: true }))) {
      throw new Error("EXPUNGE recusado");
    }
    return "apagada";
  }
  if (!lixeira) {
    await abrirPasta(c, pasta, true);
    throw new SemLixeira();
  }
  const r = await moverMensagem(c, pasta, uid, lixeira.caminho);
  return r ? "lixeira" : null;
}
