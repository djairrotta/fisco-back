// Registro de atividade e erros do Correio (tabela correio.registro,
// append-only). Um logger fino usado nos caminhos de e-mail: envio,
// recebimento (vigia de caixa), IMAP/SMTP, Sieve e sistema.
//
// REGRA DE OURO: nunca grave segredos — chaves da Resend, senhas das caixas,
// tokens ou corpo de mensagem. Assunto e endereços são permitidos. Chaves
// Resend sempre mascaradas (resolverRemetente/mascararChave).
import type { Sql } from "./client.ts";

export type NivelRegistro = "info" | "aviso" | "erro";
export type AreaRegistro =
  | "envio"
  | "recebimento"
  | "imap"
  | "smtp"
  | "sieve"
  | "auth"
  | "sistema";

export const NIVEIS: readonly NivelRegistro[] = ["info", "aviso", "erro"];
export const AREAS: readonly AreaRegistro[] = [
  "envio",
  "recebimento",
  "imap",
  "smtp",
  "sieve",
  "auth",
  "sistema",
];

const MAX_MENSAGEM = 1000;

export interface EntradaRegistro {
  nivel: NivelRegistro;
  area: AreaRegistro;
  caixaId?: number | null;
  mensagem: string;
  /** JSON curto, sem segredos (assunto/endereços ok). */
  detalhe?: Record<string, unknown> | null;
}

/** Logger injetável; `registrar` nunca lança (log é best-effort). */
export interface Registrador {
  registrar(e: EntradaRegistro): Promise<void>;
}

/** Logger que grava em correio.registro. Falha de gravação só vai ao console. */
export function criarRegistrador(sql: Sql): Registrador {
  return {
    async registrar(e: EntradaRegistro): Promise<void> {
      try {
        const mensagem = e.mensagem.slice(0, MAX_MENSAGEM);
        await sql`
          INSERT INTO correio.registro (nivel, area, caixa_id, mensagem, detalhe)
          VALUES (${e.nivel}, ${e.area}, ${e.caixaId ?? null}, ${mensagem},
            ${e.detalhe == null ? null : sql.json(e.detalhe as never)})`;
      } catch (err) {
        console.error(
          "[registro] falha ao gravar:",
          (err as { code?: string })?.code ?? (err as Error)?.name ?? "erro",
        );
      }
    },
  };
}

/** Logger silencioso (testes/ambientes sem banco de log). */
export const registradorNulo: Registrador = {
  registrar: () => Promise.resolve(),
};

export interface FiltroRegistro {
  nivel?: NivelRegistro;
  area?: AreaRegistro;
  caixa?: number;
  desde?: Date;
  limite?: number;
}

export interface LinhaRegistro {
  id: number;
  ts: string;
  nivel: NivelRegistro;
  area: AreaRegistro;
  caixaId: number | null;
  mensagem: string;
  detalhe: Record<string, unknown> | null;
}

export const LIMITE_MAX = 200;

/** Mais recentes primeiro, no máximo 200 (ou o `limite` pedido). */
export async function listarRegistro(
  sql: Sql,
  f: FiltroRegistro = {},
): Promise<LinhaRegistro[]> {
  const limite = Math.min(
    Math.max(1, Math.floor(f.limite ?? LIMITE_MAX)),
    LIMITE_MAX,
  );
  const rows = await sql<
    {
      id: number;
      ts: Date;
      nivel: NivelRegistro;
      area: AreaRegistro;
      caixa_id: number | null;
      mensagem: string;
      detalhe: Record<string, unknown> | null;
    }[]
  >`
    SELECT id, ts, nivel, area, caixa_id, mensagem, detalhe
    FROM correio.registro
    WHERE ${f.nivel ? sql`nivel = ${f.nivel}` : sql`true`}
      AND ${f.area ? sql`area = ${f.area}` : sql`true`}
      AND ${f.caixa !== undefined ? sql`caixa_id = ${f.caixa}` : sql`true`}
      AND ${f.desde ? sql`ts >= ${f.desde}` : sql`true`}
    ORDER BY ts DESC, id DESC
    LIMIT ${limite}`;
  return rows.map((r) => ({
    id: r.id,
    ts: new Date(r.ts).toISOString(),
    nivel: r.nivel,
    area: r.area,
    caixaId: r.caixa_id,
    mensagem: r.mensagem,
    detalhe: r.detalhe,
  }));
}

/** Remove linhas com mais de `dias` (padrão 30). Devolve quantas apagou. */
export async function trimRegistro(
  sql: Sql,
  agora: Date = new Date(),
  dias = 30,
): Promise<number> {
  const corte = new Date(agora.getTime() - dias * 86_400_000);
  const r = await sql`
    DELETE FROM correio.registro WHERE ts < ${corte} RETURNING id`;
  return r.length;
}
