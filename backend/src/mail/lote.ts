// Ações em lote sobre uma lista de UIDs de uma pasta: lida/não lida,
// estrela, mover, arquivar, excluir (Lixeira, ou expurgo se já na Lixeira),
// spam (para Junk) e não é spam (para a Entrada).
import type { ImapFlow } from "imapflow";
import {
  abrirPasta,
  acharPasta,
  listarPastas,
  type Pasta,
  SemLixeira,
} from "./leitura.ts";
import { garantirPasta } from "./pastas.ts";

export const ACOES_LOTE = [
  "lida",
  "nao_lida",
  "estrela",
  "sem_estrela",
  "mover",
  "arquivar",
  "excluir",
  "spam",
  "nao_spam",
] as const;
export type AcaoLote = typeof ACOES_LOTE[number];

export const MAX_LOTE = 500;

/** Pedido coerente com a pasta (ex.: arquivar o que já está no Arquivo). */
export class AcaoInvalida extends Error {
  constructor(m: string) {
    super(m);
    this.name = "AcaoInvalida";
  }
}

export class DestinoNaoEncontrado extends Error {
  constructor() {
    super("Pasta de destino não encontrada");
    this.name = "DestinoNaoEncontrado";
  }
}

export interface ResultadoLote {
  acao: AcaoLote;
  /** Mensagens que existiam na pasta e foram afetadas. */
  afetadas: number;
  /** UIDs pedidos que não existem (mais) na pasta. */
  naoEncontradas: number[];
  /** Pasta de destino, nas ações que movem. */
  destino?: string;
  /** UID antigo → novo, quando o servidor informa (UIDPLUS). */
  novosUids?: Record<string, number>;
  /** Só em `excluir`: foram para a Lixeira ou apagadas de vez. */
  resultado?: "lixeira" | "apagadas";
}

/** "1,2,3,7,9,10" → "1:3,7,9:10" (conjunto de UIDs compacto). */
export function compactarUids(uids: number[]): string {
  const xs = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < xs.length;) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
    out.push(i === j ? String(xs[i]) : `${xs[i]}:${xs[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

const mesma = (a: string, b: string) =>
  a === b || (a.toUpperCase() === "INBOX" && b.toUpperCase() === "INBOX");

const FLAGS: Partial<Record<AcaoLote, [add: boolean, flag: string]>> = {
  lida: [true, "\\Seen"],
  nao_lida: [false, "\\Seen"],
  estrela: [true, "\\Flagged"],
  sem_estrela: [false, "\\Flagged"],
};

/** Destino das ações que movem; lança se não fizer sentido ou não existir. */
async function destinoDe(
  c: ImapFlow,
  pastas: Pasta[],
  pasta: string,
  acao: AcaoLote,
  destino?: string,
): Promise<string> {
  const doTipo = (t: Parameters<typeof acharPasta>[1]) =>
    acharPasta(pastas, t)?.caminho;
  switch (acao) {
    case "mover": {
      if (!destino) throw new AcaoInvalida("Informe a pasta de destino");
      if (mesma(destino, pasta)) {
        throw new AcaoInvalida("As mensagens já estão nessa pasta");
      }
      if (!pastas.some((p) => mesma(p.caminho, destino))) {
        throw new DestinoNaoEncontrado();
      }
      return destino;
    }
    case "arquivar": {
      const a = await garantirPasta(c, "arquivo", pastas);
      if (mesma(a, pasta)) {
        throw new AcaoInvalida("As mensagens já estão no Arquivo");
      }
      return a;
    }
    case "spam": {
      const s = await garantirPasta(c, "spam", pastas);
      if (mesma(s, pasta)) {
        throw new AcaoInvalida("As mensagens já estão no Spam");
      }
      return s;
    }
    case "nao_spam": {
      if (mesma(pasta, "INBOX")) {
        throw new AcaoInvalida("As mensagens já estão na Entrada");
      }
      return "INBOX";
    }
    case "excluir": {
      const l = doTipo("lixeira");
      if (!l) throw new SemLixeira();
      return l;
    }
    default:
      throw new AcaoInvalida("Ação inválida");
  }
}

/**
 * Executa `acao` nos `uids` da `pasta`. UIDs inexistentes são ignorados e
 * devolvidos em `naoEncontradas`. Lança PastaNaoEncontrada, SemLixeira,
 * SemPastaEspecial (Spam), DestinoNaoEncontrado ou AcaoInvalida.
 */
export async function executarLote(
  c: ImapFlow,
  pasta: string,
  uids: number[],
  acao: AcaoLote,
  destino?: string,
): Promise<ResultadoLote> {
  const flag = FLAGS[acao];
  let alvo: string | undefined;
  let apagar = false;
  if (!flag) {
    const pastas = await listarPastas(c);
    if (acao === "excluir") {
      const l = acharPasta(pastas, "lixeira");
      apagar = !!l && mesma(l.caminho, pasta);
    }
    if (!apagar) alvo = await destinoDe(c, pastas, pasta, acao, destino);
  }

  await abrirPasta(c, pasta, false);
  const pedidos = [...new Set(uids)];
  const achados = new Set(
    (await c.search({ uid: compactarUids(pedidos) }, { uid: true })) || [],
  );
  const existentes = pedidos.filter((u) => achados.has(u));
  const r: ResultadoLote = {
    acao,
    afetadas: existentes.length,
    naoEncontradas: pedidos.filter((u) => !achados.has(u)),
  };
  if (alvo) r.destino = alvo;
  if (acao === "excluir") r.resultado = apagar ? "apagadas" : "lixeira";
  if (!existentes.length) return r;
  const conjunto = compactarUids(existentes);

  if (flag) {
    const [add, f] = flag;
    const ok = add
      ? await c.messageFlagsAdd(conjunto, [f], { uid: true })
      : await c.messageFlagsRemove(conjunto, [f], { uid: true });
    if (!ok) throw new Error("STORE recusado");
    return r;
  }
  if (apagar) {
    if (!(await c.messageDelete(conjunto, { uid: true }))) {
      throw new Error("EXPUNGE recusado");
    }
    return r;
  }
  // palavras-chave usadas por filtros anti-spam (Apple Mail, Thunderbird);
  // melhor esforço: servidores sem PERMANENTFLAGS \* recusam
  if (acao === "spam" || acao === "nao_spam") {
    const [poe, tira] = acao === "spam"
      ? ["$Junk", "$NotJunk"]
      : ["$NotJunk", "$Junk"];
    try {
      await c.messageFlagsRemove(conjunto, [tira], { uid: true });
      await c.messageFlagsAdd(conjunto, [poe], { uid: true });
    } catch { /* sem palavras-chave: só move */ }
  }
  const mv = await c.messageMove(conjunto, alvo!, { uid: true });
  if (!mv) throw new Error("MOVE recusado");
  const novos: Record<string, number> = {};
  for (const [a, b] of mv.uidMap ?? []) novos[String(a)] = b;
  r.novosUids = novos;
  return r;
}
