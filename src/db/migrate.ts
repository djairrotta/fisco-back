import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "sql");
const arquivos = (await readdir(raiz)).filter(f => f.endsWith(".sql")).sort();

for (const f of arquivos) {
  const sql = await readFile(join(raiz, f), "utf8");
  process.stdout.write(`aplicando ${f} ... `);
  await pool.query(sql);
  console.log("ok");
}
console.log(`\n${arquivos.length} migracoes aplicadas.`);
await pool.end();
