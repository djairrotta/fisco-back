// Prévia da lista (~160 caracteres do corpo em texto). Barata: a
// BODYSTRUCTURE (já buscada na lista) indica a primeira parte text/plain
// (senão text/html); só os primeiros 2048 bytes dela vêm, por
// BODY.PEEK[<parte>]<0.2048> (PEEK: nunca marca como lida), num FETCH por
// número de parte. Resultado em cache LRU por (caixa, pasta, uidvalidity, uid).
import type {
  FetchMessageObject,
  ImapFlow,
  MessageStructureObject,
} from "imapflow";
import { Buffer } from "node:buffer";

export const TAMANHO_PREVIA = 160;
export const BYTES_PREVIA = 2048;
export const MAX_CACHE_PREVIAS = 5000;

export interface ParteTexto {
  parte: string;
  html: boolean;
  codificacao: string | null;
  charset: string | null;
}

/** Primeira parte text/plain que não é anexo; senão a primeira text/html. */
export function escolherParteTexto(
  raiz: MessageStructureObject,
): ParteTexto | null {
  let html: ParteTexto | null = null;
  const visitar = (n: MessageStructureObject): ParteTexto | null => {
    if (n.childNodes?.length) {
      for (const f of n.childNodes) {
        const r = visitar(f);
        if (r) return r;
      }
      return null;
    }
    const tipo = (n.type ?? "").toLowerCase();
    if (n.disposition?.toLowerCase() === "attachment") return null;
    if (tipo !== "text/plain" && tipo !== "text/html") return null;
    const p: ParteTexto = {
      parte: n.part ?? "1",
      html: tipo === "text/html",
      codificacao: n.encoding?.toLowerCase() ?? null,
      charset: n.parameters?.charset ?? null,
    };
    if (!p.html) return p;
    html ??= p;
    return null;
  };
  return visitar(raiz) ?? html;
}

function deQuotedPrintable(s: string): Uint8Array {
  const t = s.replace(/=\r?\n/g, "").replace(/=[0-9A-Fa-f]?$/, "");
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const ch = t.charCodeAt(i);
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch & 0xff);
  }
  return new Uint8Array(out);
}

function decodificador(charset: string | null): TextDecoder {
  try {
    return new TextDecoder(charset?.trim() || "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

/** Bytes (possivelmente cortados) → texto, sem caractere quebrado no fim. */
export function decodificarTrecho(
  bytes: Uint8Array,
  codificacao: string | null,
  charset: string | null,
): string {
  let b = bytes;
  const cod = (codificacao ?? "").toLowerCase();
  const ascii = Buffer.from(bytes).toString("latin1");
  if (cod === "base64") {
    const limpo = ascii.replace(/[^A-Za-z0-9+/=]/g, "");
    b = new Uint8Array(
      Buffer.from(limpo.slice(0, limpo.length - (limpo.length % 4)), "base64"),
    );
  } else if (cod === "quoted-printable") {
    b = deQuotedPrintable(ascii);
  }
  return decodificador(charset).decode(b).replace(/�+$/, "");
}

const ENTIDADES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Texto de prévia: sem HTML, espaços colapsados, até ~160 caracteres. */
export function textoDaPrevia(t: string, html: boolean): string {
  let s = t;
  if (html) {
    s = s
      .replace(/<(style|script|head|title)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(-->|$)/g, " ")
      .replace(/<[^>]*(>|$)/g, " ")
      .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
          const n = e[1].toLowerCase() === "x"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
          try {
            return String.fromCodePoint(n);
          } catch {
            return " ";
          }
        }
        return ENTIDADES[e.toLowerCase()] ?? m;
      });
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= TAMANHO_PREVIA) return s;
  const corte = s.slice(0, TAMANHO_PREVIA);
  const espaco = corte.lastIndexOf(" ");
  return (espaco > TAMANHO_PREVIA * 0.7 ? corte.slice(0, espaco) : corte)
    .trimEnd();
}

/** LRU em memória (Map em ordem de uso). */
export class CachePrevias {
  private m = new Map<string, string>();
  constructor(private max = MAX_CACHE_PREVIAS) {}
  private chave(
    caixa: string,
    pasta: string,
    uv: bigint | number,
    uid: number,
  ) {
    return `${caixa}\u0000${pasta}\u0000${uv}\u0000${uid}`;
  }
  obter(caixa: string, pasta: string, uv: bigint | number, uid: number) {
    const k = this.chave(caixa, pasta, uv, uid);
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  definir(
    caixa: string,
    pasta: string,
    uv: bigint | number,
    uid: number,
    v: string,
  ) {
    const k = this.chave(caixa, pasta, uv, uid);
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) {
      this.m.delete(this.m.keys().next().value!);
    }
  }
  get tamanho() {
    return this.m.size;
  }
}

export const cachePrevias = new CachePrevias();

/** Corpo da parte no mapa do imapflow ("1", "1]<0>", "1<0>"…). */
function corpoDaParte(
  m: FetchMessageObject,
  parte: string,
): Buffer | undefined {
  for (const [k, v] of m.bodyParts ?? []) {
    const n = k.replace(/\]?<\d+>$/, "").replace(/\]$/, "");
    if (n.toLowerCase() === parte.toLowerCase()) return v;
  }
  return undefined;
}

/**
 * Prévias das mensagens já buscadas (com bodyStructure) da pasta aberta.
 * Um FETCH por número de parte distinto (normalmente 1 ou 2 por página).
 * Falha ao buscar → prévias vazias, a lista nunca falha por isso.
 */
export async function previas(
  c: ImapFlow,
  pasta: string,
  msgs: FetchMessageObject[],
  cache: CachePrevias = cachePrevias,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const caixa = String(
    (c as unknown as { options?: { auth?: { user?: string } } }).options
      ?.auth?.user ?? "",
  );
  const uv = c.mailbox ? c.mailbox.uidValidity : 0n;
  const porParte = new Map<string, { uid: number; p: ParteTexto }[]>();
  for (const m of msgs) {
    const em = cache.obter(caixa, pasta, uv, m.uid);
    if (em !== undefined) {
      out.set(m.uid, em);
      continue;
    }
    const p = m.bodyStructure ? escolherParteTexto(m.bodyStructure) : null;
    if (!p) {
      out.set(m.uid, "");
      cache.definir(caixa, pasta, uv, m.uid, "");
      continue;
    }
    const l = porParte.get(p.parte) ?? [];
    l.push({ uid: m.uid, p });
    porParte.set(p.parte, l);
  }
  for (const [parte, itens] of porParte) {
    const por = new Map(itens.map((x) => [x.uid, x.p]));
    try {
      for await (
        const m of c.fetch(
          itens.map((x) => x.uid).join(","),
          { uid: true, bodyParts: [{ key: parte, maxLength: BYTES_PREVIA }] },
          { uid: true },
        )
      ) {
        const p = por.get(m.uid);
        const b = corpoDaParte(m, parte);
        if (!p || !b) continue;
        const t = textoDaPrevia(
          decodificarTrecho(new Uint8Array(b), p.codificacao, p.charset),
          p.html,
        );
        out.set(m.uid, t);
        cache.definir(caixa, pasta, uv, m.uid, t);
      }
    } catch (e) {
      console.error(
        "[previa] falha ao buscar trechos:",
        (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
      );
    }
  }
  return out;
}
