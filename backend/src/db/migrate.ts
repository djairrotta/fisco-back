import { sql as defaultSql } from "./client.ts";

type Sql = typeof defaultSql;

const DIR = new URL("./migrations/", import.meta.url);

/** Aplica migrações *.sql em ordem alfabética, registrando em correio.migracoes. Idempotente. */
export async function migrate(client: Sql = defaultSql): Promise<void> {
  await client.unsafe(`CREATE SCHEMA IF NOT EXISTS correio`);
  await client.unsafe(
    `CREATE TABLE IF NOT EXISTS correio.migracoes (nome text PRIMARY KEY, aplicada timestamptz NOT NULL DEFAULT now())`,
  );
  const files: string[] = [];
  for await (const e of Deno.readDir(DIR)) {
    if (e.isFile && e.name.endsWith(".sql")) files.push(e.name);
  }
  files.sort();
  for (const nome of files) {
    await client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(727275)`;
      const done =
        await tx`SELECT 1 FROM correio.migracoes WHERE nome = ${nome}`;
      if (done.length) return;
      await tx.unsafe(await Deno.readTextFile(new URL(nome, DIR)));
      await tx`INSERT INTO correio.migracoes (nome) VALUES (${nome})`;
    });
  }
}
