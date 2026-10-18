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
import rotasPesquisa, { aquecerPainel } from "./routes/pesquisa.js";
import rotasLeads from "./routes/leads.js";
import rotasQuadros from "./routes/quadros.js";
import rotasNotas from "./routes/notas.js";
import rotasInternet from "./routes/internet.js";
import rotasHistorico from "./routes/historico.js";
import rotasBusca from "./routes/busca.js";
import rotasExportar from "./routes/exportar.js";
import rotasIa from "./routes/ia.js";
import rotasMonitoramento, { iniciarMonitoramento } from "./routes/monitoramento.js";
import rotasApiPublica from "./routes/api-publica.js";
import rotasCrmExtra, { iniciarLembretes } from "./routes/crm-extra.js";
import rotasCampanhas, { iniciarEnvioCampanhas } from "./routes/campanhas.js";
import rotasListas, { iniciarFilaInternet } from "./routes/listas.js";
import { garantirReferencias } from "./services/referencias.js";
import { preencherViewsVazias, recalcularSeDadoNovo } from "./db/views-boot.js";
import { garantirTransacaoSp } from "./etl/sp-transacao.js";
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

let migracao = await migrarNoBoot();
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
await app.register(rotasPesquisa);
await app.register(rotasLeads);
await app.register(rotasQuadros);
await app.register(rotasNotas);
await app.register(rotasInternet);
await app.register(rotasHistorico);
await app.register(rotasBusca);
await app.register(rotasExportar);
await app.register(rotasIa);
await app.register(rotasMonitoramento);
await app.register(rotasApiPublica);
await app.register(rotasCrmExtra);
await app.register(rotasCampanhas);
await app.register(rotasListas);

// Agendador DEPOIS do listen: carga pesada nao pode atrasar o healthcheck.
await app.listen({ port: env.PORT, host: "0.0.0.0" });
// Views que a migracao cria vazias (ver db/views-boot.ts). Em segundo
// plano: o servidor ja esta atendendo enquanto isso roda.
// O agendador so liga DEPOIS: carga trimestral (DELETE + INSERT de milhoes
// de linhas) competindo com a correcao de dados e o preenchimento das views
// faria um dos dois estourar o lock_timeout.
//
// Migracao pendente (lock_timeout: havia carga da PGFN segurando a tabela,
// as vezes uma transacao orfa do container anterior, que o Postgres so
// encerra quando o comando dela termina) e TENTADA DE NOVO a cada 2 min.
// Sem isso o banco ficava com schema velho ate o proximo deploy, e o
// codigo novo quebrava (coluna/tabela inexistente). O agendador so liga
// depois que a migracao passa: se ligasse antes, a carga dele seguraria a
// tabela e a migracao nunca passaria.
async function migracaoAplicada() {
  while (!migracao.ok) {
    await new Promise((r) => setTimeout(r, 120_000));
    migracao = await migrarNoBoot();
    if (migracao.ok) await carregarTeses().catch(() => {});
  }
}
const tarefasDeBoot = migracaoAplicada()
  .then(() => preencherViewsVazias().then(recalcularSeDadoNovo).then(garantirTransacaoSp).then(garantirReferencias).then(aquecerPainel))
  .catch(() => {});
void tarefasDeBoot.finally(() => { iniciarAgendador(); iniciarFilaInternet(); iniciarEnvioCampanhas(); iniciarLembretes(); iniciarMonitoramento(); });
