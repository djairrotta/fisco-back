import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import { migrarNoBoot, carregarTeses } from "./db/bootstrap.js";
import { pool } from "./db/pool.js";
import rotasMapa from "./routes/mapa.js";
import rotasTeses from "./routes/teses.js";
import rotasPecas from "./routes/pecas.js";
import rotasAuth from "./routes/auth.js";
import rotasFontes from "./routes/fontes.js";
import rotasSocios from "./routes/socios.js";
import { iniciarAgendador } from "./etl/agendador.js";

declare module "fastify" {
  interface FastifyInstance { authenticate: any }
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: env.CORS_ORIGINS.split(",") });
await app.register(jwt, { secret: env.JWT_SECRET });
await app.register(rateLimit, { max: 240, timeWindow: "1 minute" });

app.decorate("authenticate", async (req: any, reply: any) => {
  try { await req.jwtVerify(); } catch { reply.code(401).send({ erro: "nao autenticado" }); }
});

const migracao = await migrarNoBoot();
if (migracao.ok) await carregarTeses();

// /health consulta o banco de verdade. Um health que responde 200 sem
// tocar no Postgres mente: o processo pode estar vivo com o banco fora.
// Por isso ha dois campos distintos: `migracao` e o estado da conexao.
app.get("/health", async (_req, reply) => {
  const t0 = Date.now();
  let conexao: "ok" | "falha" = "falha";
  let latencia_ms: number | null = null;
  let schema = false;
  let erro_conexao: string | undefined;

  try {
    // Prontidao real = consigo responder consulta util. Isso e a conexao
    // mais a existencia do schema, NAO o sucesso da ultima migracao.
    const r = await pool.query(
      `SELECT to_regclass('fisco.divida_inscricao') IS NOT NULL AS tem`);
    conexao = "ok";
    schema = r.rows[0]?.tem === true;
    latencia_ms = Date.now() - t0;
  } catch (e: any) {
    erro_conexao = String(e?.message ?? e).slice(0, 200);
  }

  // Migracao pendente NAO derruba o container. Durante uma carga da PGFN
  // o lock_timeout faz a migracao de boot desistir; se o 503 valesse por
  // isso, o orquestrador reiniciaria o container a cada trimestre, no pior
  // momento possivel. 503 so quando o banco nao responde ou o schema nao
  // existe, que sao os casos em que servir e mentira.
  const pronto = conexao === "ok" && schema;

  const corpo = {
    ok: pronto,
    servico: "fisco-backend",
    banco: {
      conexao,
      latencia_ms,
      schema: schema ? "presente" : "ausente",
      migracao: migracao.ok ? "aplicada" : "pendente",
      ...(erro_conexao ? { erro_conexao } : {}),
      ...(migracao.erro ? { erro_migracao: migracao.erro } : {}),
    },
  };
  return reply.code(pronto ? 200 : 503).send(corpo);
});

await app.register(rotasAuth);
await app.register(rotasFontes);
await app.register(rotasSocios);
await app.register(rotasMapa);
await app.register(rotasTeses);
await app.register(rotasPecas);

// Agendador DEPOIS do listen: carga pesada nao pode atrasar o healthcheck.
await app.listen({ port: env.PORT, host: "0.0.0.0" });
iniciarAgendador();
