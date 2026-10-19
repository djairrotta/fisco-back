// Busca com filtros (IMAP SEARCH) numa pasta ou em todas, e a visão virtual
// Favoritos (\Flagged na Entrada e no Arquivo). Resultado limitado e
// ordenado pela data, mais nova primeiro; cada item diz a sua pasta.
import type { ImapFlow, SearchObject } from "imapflow";
import {
  abrirPasta,
  acharPasta,
  coletar,
  item,
  type ItemLista,
  itensComPrevia,
  listarPastas,
  type Pasta,
} from "./leitura.ts";
import { compactarUids } from "./lote.ts";

export const LIMITE_BUSCA = 200;
/** Com `temAnexo`, quantos candidatos por pasta no máximo examinar. */
const MAX_EXAMINADOS = 2000;
const LOTE_FETCH = 100;

export interface FiltrosBusca {
  de?: string;
  para?: string;
  assunto?: string;
  /** Corpo da mensagem (BODY). */
  texto?: string;
  temAnexo?: boolean;
  naoLidas?: boolean;
  /** Data do e-mail (cabeçalho Date) a partir deste dia, inclusive (UTC). */
  desde?: Date;
  /** Data do e-mail até este dia, inclusive (UTC). */
  ate?: Date;
}

export interface ItemBusca extends ItemLista {
  pasta: string;
}

export interface ResultadoBusca {
  mensagens: ItemBusca[];
  /** true quando havia mais resultados que o limite. */
  limitado: boolean;
}

const DIA_MS = 86_400_000;

/** Critério IMAP SEARCH dos filtros (sem temAnexo, que é filtrado depois). */
export function criterio(f: FiltrosBusca): SearchObject {
  const s: SearchObject = {};
  if (f.de) s.from = f.de;
  if (f.para) s.to = f.para;
  if (f.assunto) s.subject = f.assunto;
  if (f.texto) s.body = f.texto;
  if (f.naoLidas) s.seen = false;
  if (f.desde) s.sentSince = f.desde;
  if (f.ate) s.sentBefore = new Date(f.ate.getTime() + DIA_MS);
  if (!Object.keys(s).length) s.all = true;
  return s;
}

const temAnexos = (m: ItemLista) => m.temAnexo;

/** Busca numa pasta: até `limite` itens, dos UIDs mais altos para os mais baixos. */
async function buscarNaPasta(
  c: ImapFlow,
  pasta: string,
  busca: SearchObject,
  limite: number,
  soComAnexo: boolean,
): Promise<{ itens: ItemBusca[]; mais: boolean }> {
  await abrirPasta(c, pasta, true);
  const uids = ((await c.search(busca, { uid: true })) || [])
    .sort((a, b) => b - a);
  const itens: ItemBusca[] = [];
  let mais = false;
  for (let i = 0; i < uids.length && !mais; i += LOTE_FETCH) {
    if (itens.length >= limite || (soComAnexo && i >= MAX_EXAMINADOS)) {
      mais = true;
      break;
    }
    const fatia = uids.slice(i, i + LOTE_FETCH);
    const brutas = (await coletar(c, compactarUids(fatia), true))
      .sort((a, b) => b.uid - a.uid)
      .filter((m) => !soComAnexo || temAnexos(item(m)));
    // prévia só do que pode entrar no resultado
    const ms = await itensComPrevia(
      c,
      pasta,
      brutas.slice(0, limite - itens.length),
    );
    if (brutas.length > ms.length) mais = true;
    for (const m of ms) {
      if (itens.length >= limite) {
        mais = true;
        break;
      }
      itens.push({ ...m, pasta });
    }
  }
  return { itens, mais };
}

function maisNovaPrimeiro(a: ItemBusca, b: ItemBusca): number {
  const da = a.data ?? "", db = b.data ?? "";
  if (da !== db) return da < db ? 1 : -1;
  return b.uid - a.uid;
}

async function buscarEm(
  c: ImapFlow,
  pastas: string[],
  busca: SearchObject,
  soComAnexo: boolean,
  limite: number,
): Promise<ResultadoBusca> {
  let todas: ItemBusca[] = [];
  let limitado = false;
  for (const p of pastas) {
    const r = await buscarNaPasta(c, p, busca, limite, soComAnexo);
    todas = todas.concat(r.itens);
    limitado ||= r.mais;
  }
  todas.sort(maisNovaPrimeiro);
  if (todas.length > limite) limitado = true;
  return { mensagens: todas.slice(0, limite), limitado };
}

/**
 * Busca com filtros em `pasta` (caminho IMAP) ou, com `pasta` null, em
 * todas as pastas selecionáveis. Lança PastaNaoEncontrada para pasta
 * inexistente.
 */
export async function buscar(
  c: ImapFlow,
  pasta: string | null,
  f: FiltrosBusca,
  limite = LIMITE_BUSCA,
): Promise<ResultadoBusca> {
  const caminhos = pasta === null
    ? (await listarPastas(c)).map((p) => p.caminho)
    : [pasta];
  return await buscarEm(c, caminhos, criterio(f), !!f.temAnexo, limite);
}

/** Favoritos: mensagens com estrela (\Flagged) na Entrada e no Arquivo. */
export async function favoritos(
  c: ImapFlow,
  limite = LIMITE_BUSCA,
): Promise<ResultadoBusca> {
  const pastas: Pasta[] = await listarPastas(c);
  const caminhos = ["INBOX"];
  const arq = acharPasta(pastas, "arquivo");
  if (arq) caminhos.push(arq.caminho);
  return await buscarEm(c, caminhos, { flagged: true }, false, limite);
}
