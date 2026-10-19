import type { Sql } from "./client.ts";

/** Registra um evento em correio.auditoria (append-only). Nunca passe segredos em `detalhes`. */
export async function auditar(
  sql: Sql,
  ator: string,
  acao: string,
  alvo: string | null = null,
  detalhes: Record<string, unknown> | null = null,
): Promise<void> {
  await sql`INSERT INTO correio.auditoria (ator, acao, alvo, detalhes)
    VALUES (${ator}, ${acao}, ${alvo}, ${
    detalhes === null ? null : sql.json(detalhes as never)
  })`;
}
