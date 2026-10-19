// Mapeamento domínio→slot da Resend (tabelas correio.resend_dominios e
// correio.resend_contas{slot,nome}). As CHAVES ficam só no ambiente
// (ResendConfig.slots); aqui NUNCA se grava nem se devolve chave — só a
// máscara, lida do ambiente.
//
// Precedência na resolução do remetente: mapeamento do banco primeiro; se não
// houver, os domínios declarados inline nas variáveis; por fim o poste.io.
import type { Sql } from "../db/client.ts";
import { ConfigError } from "../config.ts";
import {
  contaDeSlot,
  dominioDe,
  mascararChave,
  MAX_SLOTS,
  type ResendConfig,
  resolverRemetente,
  type RotaEnvio,
} from "./resend.ts";

/** Serializa as escritas do mapeamento. */
const TRAVA_RESEND = 727277;

export class SlotInvalido extends Error {
  constructor() {
    super(`O slot deve estar entre 1 e ${MAX_SLOTS}`);
    this.name = "SlotInvalido";
  }
}

/** Tentativa de usar um slot sem chave no ambiente. */
export class ChaveSlotAusente extends Error {
  constructor(public slot: number) {
    super(
      `O slot ${slot} não tem chave no ambiente (RESEND_CONTA_${slot}); ` +
        `defina a variável antes de mapear domínios para ele`,
    );
    this.name = "ChaveSlotAusente";
  }
}

const DOMINIO =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Minúsculo e validado. Lança ConfigError. */
export function normalizarDominio(bruto: string): string {
  const d = bruto.trim().toLowerCase();
  if (!DOMINIO.test(d)) {
    throw new ConfigError(`Domínio inválido: ${d.slice(0, 100)}`);
  }
  return d;
}

export interface SlotInfo {
  slot: number;
  nome: string;
  /** Há chave no ambiente para este slot. */
  temChave: boolean;
  /** Máscara da chave do ambiente (re_7v…MPr) ou null. */
  mascara: string | null;
  dominios: string[];
}

/** Os 20 slots: nome (banco ou rótulo do ambiente), chave presente e domínios. */
export async function listarSlots(
  sql: Sql,
  env: ResendConfig | undefined,
): Promise<SlotInfo[]> {
  const nomes = new Map<number, string>();
  for (
    const r of await sql<{ slot: number; nome: string }[]>`
    SELECT slot, nome FROM correio.resend_contas`
  ) {
    nomes.set(r.slot, r.nome);
  }
  const porSlot = new Map<number, string[]>();
  for (
    const r of await sql<{ slot: number; dominio: string }[]>`
      SELECT slot, dominio FROM correio.resend_dominios
      WHERE ativo ORDER BY dominio`
  ) {
    const xs = porSlot.get(r.slot) ?? [];
    xs.push(r.dominio);
    porSlot.set(r.slot, xs);
  }
  const out: SlotInfo[] = [];
  for (let slot = 1; slot <= MAX_SLOTS; slot++) {
    const s = env?.slots.get(slot);
    out.push({
      slot,
      nome: nomes.get(slot) ?? s?.nome ?? "",
      temChave: !!s,
      mascara: s ? mascararChave(s.apikey) : null,
      dominios: porSlot.get(slot) ?? [],
    });
  }
  return out;
}

/**
 * Atribui (ou move) um domínio a um slot. Exige chave no ambiente para o slot.
 * Um domínio só fica ativo em um slot: mover remove o mapeamento anterior.
 */
export async function atribuirDominio(
  sql: Sql,
  env: ResendConfig | undefined,
  slot: number,
  dominioBruto: string,
): Promise<void> {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) {
    throw new SlotInvalido();
  }
  if (!env?.slots.has(slot)) throw new ChaveSlotAusente(slot);
  const dominio = normalizarDominio(dominioBruto);
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${TRAVA_RESEND})`;
    await tx`DELETE FROM correio.resend_dominios WHERE dominio = ${dominio}`;
    await tx`INSERT INTO correio.resend_dominios (slot, dominio)
      VALUES (${slot}, ${dominio})`;
  });
}

/** Remove o mapeamento de um domínio. true se havia. */
export async function removerDominio(
  sql: Sql,
  dominioBruto: string,
): Promise<boolean> {
  const dominio = dominioBruto.trim().toLowerCase();
  const r = await sql`DELETE FROM correio.resend_dominios
    WHERE dominio = ${dominio} RETURNING id`;
  return r.length > 0;
}

/** Renomeia um slot (upsert em resend_contas). */
export async function renomearSlot(
  sql: Sql,
  slot: number,
  nome: string,
): Promise<void> {
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) {
    throw new SlotInvalido();
  }
  const n = nome.trim().slice(0, 100);
  await sql`INSERT INTO correio.resend_contas (slot, nome) VALUES (${slot}, ${n})
    ON CONFLICT (slot) DO UPDATE SET nome = EXCLUDED.nome`;
}

/**
 * Conta do banco para `dominio` (minúsculo), com a chave do ambiente do slot.
 * null se não há mapeamento ou o slot não tem chave no ambiente (cai para o
 * fallback do env/poste).
 */
export function resolverContaDb(
  sql: Sql,
  env: ResendConfig | undefined,
  dominio: string,
): Promise<RotaEnvio | null> {
  return (async () => {
    const [r] = await sql<{ slot: number }[]>`
      SELECT slot FROM correio.resend_dominios
      WHERE ativo AND dominio = ${dominio} LIMIT 1`;
    if (!r) return null;
    const s = env?.slots.get(r.slot);
    if (!s) return null; // slot sem chave no ambiente: não envia pela Resend
    return {
      tipo: "resend",
      conta: contaDeSlot(s.apikey),
      mascara: mascararChave(s.apikey),
      slot: s.slot,
    };
  })();
}

/**
 * Resolve o caminho de envio: mapeamento do banco primeiro, depois os domínios
 * inline das variáveis, por fim o poste.io.
 */
export async function resolverRemetenteDb(
  sql: Sql,
  env: ResendConfig | undefined,
  endereco: string,
): Promise<RotaEnvio> {
  const dominio = dominioDe(endereco);
  if (dominio) {
    const db = await resolverContaDb(sql, env, dominio);
    if (db) return db;
  }
  return resolverRemetente(endereco, env);
}

/**
 * Bootstrap: na primeira subida (tabela vazia), semeia o mapeamento a partir
 * dos domínios declarados inline nas variáveis. Nunca sobrescreve o que o
 * usuário já tiver mapeado no app.
 */
export async function semearDominios(
  sql: Sql,
  env: ResendConfig | undefined,
): Promise<number> {
  if (!env?.slots.size) return 0;
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int n FROM correio.resend_dominios`;
  if (n > 0) return 0;
  let inseridos = 0;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${TRAVA_RESEND})`;
    const [{ n: n2 }] = await tx<{ n: number }[]>`
      SELECT count(*)::int n FROM correio.resend_dominios`;
    if (n2 > 0) return;
    for (const s of env.slots.values()) {
      for (const dominio of s.dominiosInline) {
        const r = await tx`
          INSERT INTO correio.resend_dominios (slot, dominio)
          VALUES (${s.slot}, ${dominio})
          ON CONFLICT DO NOTHING RETURNING id`;
        inseridos += r.length;
      }
    }
  });
  return inseridos;
}
