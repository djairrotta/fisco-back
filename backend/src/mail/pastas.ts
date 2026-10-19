// Pastas do usuário: listagem com contagens (STATUS), criação, renomeação e
// exclusão. As pastas especiais (Entrada, Rascunhos, Enviados, Arquivo,
// Spam, Lixeira) são protegidas: não se renomeiam nem se excluem.
import type { ImapFlow } from "imapflow";
import {
  acharPasta,
  listarPastas,
  NOMES_TIPO,
  type Pasta,
  PastaNaoEncontrada,
  SPECIAL_USE,
  type TipoPasta,
} from "./leitura.ts";

// ------------------------------------------------------------ erros

export class PastaProtegida extends Error {
  constructor() {
    super("Pastas especiais não podem ser renomeadas nem excluídas");
    this.name = "PastaProtegida";
  }
}

export class PastaJaExiste extends Error {
  constructor() {
    super("Já existe uma pasta com esse nome");
    this.name = "PastaJaExiste";
  }
}

export class PastaNaoVazia extends Error {
  constructor(motivo: "mensagens" | "subpastas") {
    super(
      motivo === "mensagens"
        ? "A pasta tem mensagens; mova-as ou exclua-as antes de excluir a pasta"
        : "A pasta tem subpastas; exclua-as antes",
    );
    this.name = "PastaNaoVazia";
  }
}

export class NomePastaInvalido extends Error {
  constructor(motivo: string) {
    super(motivo);
    this.name = "NomePastaInvalido";
  }
}

/** O servidor não tem a pasta especial pedida (ex.: Spam). */
export class SemPastaEspecial extends Error {
  constructor(public tipo: TipoPasta) {
    super(`Pasta ${NOMES_TIPO[tipo]} não encontrada no servidor`);
    this.name = "SemPastaEspecial";
  }
}

// ------------------------------------------------------------ listagem

export interface PastaContada {
  /** Caminho IMAP (use em `pasta=`). */
  caminho: string;
  nome: string;
  tipo: TipoPasta | null;
  /** Flag SPECIAL-USE correspondente ao tipo (\Inbox, \Archive, \Junk…). */
  specialUse: string | null;
  delimitador: string;
  /** Caminho da pasta-mãe, ou null no primeiro nível. */
  pai: string | null;
  /** Especial: não pode ser renomeada nem excluída. */
  protegida: boolean;
  total: number | null;
  naoLidas: number | null;
}

function paiDe(caminho: string, delim: string): string | null {
  const i = caminho.lastIndexOf(delim);
  return i > 0 ? caminho.slice(0, i) : null;
}

export function contada(p: Pasta): PastaContada {
  const delim = p.delimitador || "/";
  return {
    caminho: p.caminho,
    nome: p.nome,
    tipo: p.tipo,
    specialUse: p.tipo ? SPECIAL_USE[p.tipo] : null,
    delimitador: delim,
    pai: p.tipo === "entrada" ? null : paiDe(p.caminho, delim),
    protegida: p.tipo !== null,
    total: p.total ?? null,
    naoLidas: p.naoLidas ?? null,
  };
}

/** Pastas selecionáveis com total e não lidas (uma ida ao servidor por LIST-STATUS). */
export async function pastasComContagem(c: ImapFlow): Promise<PastaContada[]> {
  return (await listarPastas(c, { contagens: true })).map(contada);
}

// ------------------------------------------------------------ nomes

// deno-lint-ignore no-control-regex
const CONTROLE = /[\x00-\x1f\x7f]/;

/** Valida o nome de UM nível (sem o separador do servidor). */
export function validarNomePasta(bruto: string, delim: string): string {
  const nome = bruto.normalize("NFC").trim();
  if (!nome) throw new NomePastaInvalido("Informe o nome da pasta");
  if (nome.length > 100) {
    throw new NomePastaInvalido("Nome da pasta longo demais (até 100)");
  }
  if (CONTROLE.test(nome)) {
    throw new NomePastaInvalido("Nome da pasta inválido");
  }
  for (const ch of new Set([delim, "/", ".", "*", "%"])) {
    if (nome.includes(ch)) {
      throw new NomePastaInvalido(`O nome da pasta não pode conter "${ch}"`);
    }
  }
  if (nome.toUpperCase() === "INBOX") {
    throw new NomePastaInvalido("Nome de pasta reservado");
  }
  return nome;
}

interface Contexto {
  todas: Pasta[];
  delim: string;
  /** Prefixo do namespace pessoal (ex.: "INBOX." em alguns Dovecot). */
  prefixo: string;
}

async function contexto(c: ImapFlow): Promise<Contexto> {
  const todas = await listarPastas(c);
  const delim = c.namespace?.delimiter || todas[0]?.delimitador || "/";
  return { todas, delim, prefixo: c.namespace?.prefix ?? "" };
}

const mesmo = (a: string, b: string) =>
  a === b || (a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX");

function acharCaminho(ctx: Contexto, caminho: string): Pasta | undefined {
  return ctx.todas.find((p) => mesmo(p.caminho, caminho));
}

function existeCaminho(ctx: Contexto, caminho: string): boolean {
  const l = caminho.toLowerCase();
  return ctx.todas.some((p) => p.caminho.toLowerCase() === l);
}

// ------------------------------------------------------------ CRUD

/**
 * Cria `nome` dentro de `pai` (caminho existente) ou no primeiro nível do
 * namespace pessoal. Devolve o caminho criado.
 */
export async function criarPasta(
  c: ImapFlow,
  nomeBruto: string,
  pai?: string | null,
): Promise<string> {
  const ctx = await contexto(c);
  const nome = validarNomePasta(nomeBruto, ctx.delim);
  let caminho: string;
  if (pai) {
    const mae = acharCaminho(ctx, pai);
    if (!mae) throw new PastaNaoEncontrada();
    caminho = `${mae.caminho}${ctx.delim}${nome}`;
  } else caminho = `${ctx.prefixo}${nome}`;
  if (existeCaminho(ctx, caminho)) throw new PastaJaExiste();
  const r = await c.mailboxCreate(caminho);
  if (r && r.created === false) throw new PastaJaExiste();
  return r?.path ?? caminho;
}

/** Renomeia (mesmo nível, mesma pasta-mãe). Devolve o novo caminho. */
export async function renomearPasta(
  c: ImapFlow,
  caminho: string,
  nomeBruto: string,
): Promise<string> {
  const ctx = await contexto(c);
  const p = acharCaminho(ctx, caminho);
  if (!p) throw new PastaNaoEncontrada();
  if (p.tipo) throw new PastaProtegida();
  const nome = validarNomePasta(nomeBruto, ctx.delim);
  const delim = p.delimitador || ctx.delim;
  const mae = paiDe(p.caminho, delim);
  const novo = mae ? `${mae}${delim}${nome}` : `${ctx.prefixo}${nome}`;
  if (novo === p.caminho) return novo;
  if (
    existeCaminho(ctx, novo) && novo.toLowerCase() !== p.caminho.toLowerCase()
  ) {
    throw new PastaJaExiste();
  }
  const r = await c.mailboxRename(p.caminho, novo);
  return r?.newPath ?? novo;
}

/** Exclui uma pasta comum vazia e sem subpastas. */
export async function excluirPasta(
  c: ImapFlow,
  caminho: string,
): Promise<void> {
  const ctx = await contexto(c);
  const p = acharCaminho(ctx, caminho);
  if (!p) throw new PastaNaoEncontrada();
  if (p.tipo) throw new PastaProtegida();
  const delim = p.delimitador || ctx.delim;
  // subpastas aparecem no LIST mesmo quando \Noselect
  const lista = await c.list();
  if (lista.some((x) => x.path.startsWith(p.caminho + delim))) {
    throw new PastaNaoVazia("subpastas");
  }
  const st = await c.status(p.caminho, { messages: true });
  if (st && (st.messages ?? 0) > 0) throw new PastaNaoVazia("mensagens");
  await c.mailboxDelete(p.caminho);
}

/**
 * Caminho da pasta especial `tipo`; para Arquivo e Rascunhos, cria
 * ("Archive"/"Drafts", no mesmo nível da Lixeira ou no namespace) quando o
 * servidor não tem. Outros tipos ausentes → SemPastaEspecial.
 */
export async function garantirPasta(
  c: ImapFlow,
  tipo: TipoPasta,
  pastas?: Pasta[],
): Promise<string> {
  const todas = pastas ?? await listarPastas(c);
  const p = acharPasta(todas, tipo);
  if (p) return p.caminho;
  if (tipo !== "arquivo" && tipo !== "rascunhos") {
    throw new SemPastaEspecial(tipo);
  }
  const nome = tipo === "arquivo" ? "Archive" : "Drafts";
  // mesmo nível de uma pasta especial existente (respeita prefixo INBOX.)
  const ref = todas.find((x) => x.tipo && x.tipo !== "entrada");
  let caminho = `${c.namespace?.prefix ?? ""}${nome}`;
  if (ref) {
    const delim = ref.delimitador || "/";
    const mae = paiDe(ref.caminho, delim);
    caminho = mae ? `${mae}${delim}${nome}` : nome;
  }
  const r = await c.mailboxCreate(caminho);
  return r?.path ?? caminho;
}
