import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { env } from "./lib/env.js";
import rotasMapa from "./routes/mapa.js";
import rotasTeses from "./routes/teses.js";
import rotasPecas from "./routes/pecas.js";

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

app.get("/health", async () => ({ ok: true, servico: "fisco-backend" }));

await app.register(rotasMapa);
await app.register(rotasTeses);
await app.register(rotasPecas);

await app.listen({ port: env.PORT, host: "0.0.0.0" });
