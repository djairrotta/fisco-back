import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;
let inst: Sql | undefined;

function get(): Sql {
  if (!inst) {
    const url = Deno.env.get("DATABASE_URL");
    if (!url) {
      throw new Error(
        "DATABASE_URL não definida: configure a conexão com o Postgres",
      );
    }
    inst = postgres(url, { max: 10, onnotice: () => {} });
  }
  return inst;
}

// Instância preguiçosa: valida DATABASE_URL e conecta só no primeiro uso.
export const sql: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply: (_t, _this, args) =>
    (get() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop) => {
    const v = Reflect.get(get(), prop);
    return typeof v === "function" ? v.bind(get()) : v;
  },
});
