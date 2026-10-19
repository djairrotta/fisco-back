// Pedidos de liberação de conector: quando chega uma transação de conector
// (caminhos MCP/OAuth/admin) de uma origem DESCONHECIDA — nem a faixa embutida da
// Anthropic, nem os vendedores buscados, nem uma decisão anterior —, o Vigia
// registra um pedido e pergunta ao usuário por push: temporário, permanente ou
// bloquear. Até decidir, a origem segue barrada pela regra geo/datacenter (default
// seguro). A decisão entra na allowlist (vigia.conector_faixas) e a regra de skip
// do conector é reaplicada.
import type { Sql } from "../db/client.ts";
import { auditar } from "../monitor/executor.ts";
import { ipCasa } from "../monitor/decision.ts";
import type { Evento } from "../monitor/types.ts";

/** Caminhos que caracterizam uma transação de conector/admin (MCP + OAuth + API). */
export const CAMINHO_CONECTOR =
  /^\/(mcp\b|mcp$|oauth\/|\.well-known\/|api\/v1\/)/i;

export type ModoDecisao = "temporario" | "permanente" | "bloquear";
export const HORAS_TEMP_PADRAO = 24;

export interface Pedido {
  id: number;
  faixa: string;
  ip: string | null;
  origem: string;
  caminho: string;
  estado: "pendente" | "temporario" | "permanente" | "bloqueado";
  criado: string;
  decidido: string | null;
}

/** Reduz um IP à sua faixa /24 (IPv4) ou /48 (IPv6) — granularidade do pedido. */
export function faixaDe(ip: string): string {
  const s = ip.trim();
  if (s.includes(":")) {
    const h = s.split("%")[0].split(":");
    // Expande o "::" para pegar os 3 primeiros hextets de forma estável.
    const vazio = h.indexOf("");
    let cheio = h;
    if (vazio !== -1) {
      const faltam = 8 - h.filter((x) => x !== "").length;
      cheio = [
        ...h.slice(0, vazio),
        ...Array(faltam).fill("0"),
        ...h.slice(vazio + 1),
      ].filter((x) => x !== "" || true);
      cheio = cheio.map((x) => (x === "" ? "0" : x));
    }
    const p = cheio.slice(0, 3).map((x) => x || "0");
    while (p.length < 3) p.push("0");
    return `${p.join(":")}::/48`;
  }
  const o = s.split(".");
  if (o.length === 4) return `${o[0]}.${o[1]}.${o[2]}.0/24`;
  return s;
}

export interface CtxConector {
  /** Faixas/IPs já conhecidos do conector (Anthropic embutida + vendedores + decisões). */
  conhecidos: string[];
  /** ASNs de datacenter/VPS ativos (um IP de datacenter num caminho de conector é suspeito). */
  asnsDatacenter: ReadonlySet<number>;
  vigiaHost: string;
}

/**
 * Detecta transações de conector de origem desconhecida nos eventos do ciclo.
 * Uma por faixa (/24 ou /48). Só conta quem está num caminho de conector, é de
 * fora do Brasil OU de ASN de datacenter, e NÃO é coberto por faixa conhecida.
 */
export function detectarConectores(
  eventos: Evento[],
  ctx: CtxConector,
): { faixa: string; ip: string; origem: string; caminho: string }[] {
  const porFaixa = new Map<
    string,
    { faixa: string; ip: string; origem: string; caminho: string }
  >();
  for (const e of eventos) {
    if (!e.ip || !CAMINHO_CONECTOR.test(e.caminho)) continue;
    const estrangeiro = e.pais !== "" && e.pais.toUpperCase() !== "BR";
    const datacenter = e.asn > 0 && ctx.asnsDatacenter.has(e.asn);
    if (!estrangeiro && !datacenter) continue; // residencial/BR: não é "conector" suspeito
    if (ctx.conhecidos.some((f) => ipCasa(e.ip, f))) continue; // já liberado
    const faixa = faixaDe(e.ip);
    if (porFaixa.has(faixa)) continue;
    const origem = [
      datacenter ? `ASN ${e.asn}` : null,
      e.pais ? e.pais.toUpperCase() : null,
    ].filter(Boolean).join(" ");
    porFaixa.set(faixa, { faixa, ip: e.ip, origem, caminho: e.caminho });
  }
  return [...porFaixa.values()];
}

/**
 * Registra um pedido pendente para a faixa (idempotente pelo índice único).
 * Devolve o id do pedido novo (para notificar uma vez por faixa), ou null se já
 * existia um pedido para essa faixa.
 */
export async function registrarPedido(
  sql: Sql,
  p: { faixa: string; ip?: string; origem?: string; caminho?: string },
): Promise<number | null> {
  const rows = await sql`
    INSERT INTO vigia.conector_pedido (faixa, ip, origem, caminho)
    VALUES (${p.faixa}, ${p.ip ?? null}, ${p.origem ?? ""}, ${p.caminho ?? ""})
    ON CONFLICT (faixa) DO NOTHING
    RETURNING id`;
  return rows.length > 0 ? Number(rows[0].id) : null;
}

export async function listarPedidos(sql: Sql): Promise<Pedido[]> {
  const rows = await sql`
    SELECT id, faixa, ip, origem, caminho, estado, criado, decidido
    FROM vigia.conector_pedido ORDER BY
      (estado = 'pendente') DESC, criado DESC`;
  return rows.map((r) => ({
    id: Number(r.id),
    faixa: String(r.faixa),
    ip: r.ip ? String(r.ip) : null,
    origem: String(r.origem),
    caminho: String(r.caminho),
    estado: r.estado as Pedido["estado"],
    criado: new Date(r.criado as string).toISOString(),
    decidido: r.decidido ? new Date(r.decidido as string).toISOString() : null,
  }));
}

/**
 * Aplica (só no banco) a decisão do usuário sobre uma faixa de conector.
 * `temporario` libera por `horas`; `permanente` para sempre; `bloquear` tira da
 * allowlist (segue barrado pelo default). Quem reaplica a regra de skip na borda
 * é a camada de cima (op reaplicarConector), que tem acesso ao Cloudflare.
 */
export async function aplicarDecisaoConector(
  sql: Sql,
  agora: Date,
  entrada: { id?: number; faixa?: string; modo: ModoDecisao; horas?: number },
  ator = "usuario",
): Promise<{ faixa: string; estado: Pedido["estado"] }> {
  let faixa = entrada.faixa?.trim();
  if (!faixa && entrada.id !== undefined) {
    const [p] = await sql`
      SELECT faixa FROM vigia.conector_pedido WHERE id = ${entrada.id}`;
    if (!p) throw new Error(`pedido ${entrada.id} não encontrado`);
    faixa = String(p.faixa);
  }
  if (!faixa) throw new Error("informe id ou faixa");
  if (!["temporario", "permanente", "bloquear"].includes(entrada.modo)) {
    throw new Error("modo inválido (temporario, permanente ou bloquear)");
  }

  const horas = entrada.horas && entrada.horas > 0
    ? entrada.horas
    : HORAS_TEMP_PADRAO;
  let estado: Pedido["estado"];
  if (entrada.modo === "permanente") {
    estado = "permanente";
    await sql`
      INSERT INTO vigia.conector_faixas (faixa, modo, origem, expira)
      VALUES (${faixa}, 'permanente', 'decisao', NULL)
      ON CONFLICT (faixa) DO UPDATE SET modo = 'permanente', origem = 'decisao',
        expira = NULL`;
  } else if (entrada.modo === "temporario") {
    estado = "temporario";
    const expira = new Date(agora.getTime() + horas * 3_600_000);
    await sql`
      INSERT INTO vigia.conector_faixas (faixa, modo, origem, expira)
      VALUES (${faixa}, 'temporario', 'decisao', ${expira})
      ON CONFLICT (faixa) DO UPDATE SET modo = 'temporario', origem = 'decisao',
        expira = ${expira}`;
  } else {
    estado = "bloqueado";
    // Tira a liberação (vendedor não: só decisões do usuário). Segue barrado.
    await sql`DELETE FROM vigia.conector_faixas
      WHERE faixa = ${faixa} AND modo IN ('permanente', 'temporario')`;
  }

  await sql`
    INSERT INTO vigia.conector_pedido (faixa, estado, decidido)
    VALUES (${faixa}, ${estado}, now())
    ON CONFLICT (faixa) DO UPDATE SET estado = ${estado}, decidido = now()`;
  await auditar(sql, ator, "conector_decisao", faixa, {
    modo: entrada.modo,
    horas: entrada.modo === "temporario" ? horas : undefined,
  });
  return { faixa, estado };
}
