import pg from "pg";

// DATE vira texto "AAAA-MM-DD". O padrao do driver converte em Date na
// meia-noite LOCAL, e o JSON sai em UTC: 15/02 aparecia como 14/02 na tela.
pg.types.setTypeParser(1082, (v: string) => v);
import { env } from "../lib/env.js";

// Um unico container Postgres atende todos os apps; o schema `fisco`
// isola este produto dos demais.
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 12,
  options: "-c search_path=fisco,public",
});

export async function q<T = any>(sql: string, params: unknown[] = []) {
  const r = await pool.query(sql, params);
  return r.rows as T[];
}
