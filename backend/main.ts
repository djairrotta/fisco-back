import type { Hono } from "@hono/hono";
import { type Config, loadConfig } from "./src/config.ts";
import { type Sql, sql as sqlPadrao } from "./src/db/client.ts";
import { migrate } from "./src/db/migrate.ts";
import { depsPadrao as webauthnDepsPadrao } from "./src/auth/webauthn.ts";
import { criarApp } from "./src/api/app.ts";
import { depsPadrao as pushDepsPadrao, enviarPush } from "./src/notify/push.ts";
import { DIR_PUBLICO_PADRAO, montarEstatico } from "./src/http/estatico.ts";
import { criarClassificador } from "./src/ai/classificador.ts";
import { GerenciadorCaixas } from "./src/mail/vigia_caixa.ts";
import { criarPool } from "./src/mail/pool.ts";
import { filaPadrao, type FilaSaida } from "./src/mail/saida.ts";
import {
  aguardarNotificacoes,
  notificar,
  type NotificarDeps,
} from "./src/notify/notificar.ts";
import {
  DIR_DADOS_PADRAO,
  garantirSegredos,
  mensagemPrimeiroAcesso,
} from "./src/segredos.ts";
import { criarRegistrador, trimRegistro } from "./src/db/registro.ts";
import { semearDominios } from "./src/mail/resend_contas.ts";

export interface OpcoesBoot {
  env: Record<string, string | undefined>;
  sql: Sql;
  dirDados: string;
  dirPublico: string;
  log?: (m: string) => void;
}

/**
 * Boot: garantirSegredos → loadConfig → migrate → aviso de primeiro acesso →
 * app (API + PWA estático), o gerenciador dos vigias de INBOX e o worker
 * da Caixa de saída (ambos ainda parados). Não abre porta nem conecta ao IMAP; `principal` faz o
 * Deno.serve e o `vigia.start()`.
 */
export async function iniciar(
  o: OpcoesBoot,
): Promise<
  { app: Hono; config: Config; vigia: GerenciadorCaixas; fila: FilaSaida }
> {
  const log = o.log ?? console.log;
  const env = await garantirSegredos(o.env, o.dirDados);
  const config = loadConfig(env);

  if (!config.mailSecure) {
    log(
      "ATENÇÃO: MAIL_SECURE=false — IMAP e SMTP SEM TLS; senhas das caixas trafegam em texto puro. Use só em testes/desenvolvimento.",
    );
  }

  await migrate(o.sql);
  // bootstrap: semeia o mapeamento domínio→slot a partir dos `| dominios`
  // declarados nas variáveis, só na primeira subida (tabela vazia).
  try {
    const n = await semearDominios(o.sql, config.resend);
    if (n) log(`[resend] ${n} domínio(s) semeado(s) do ambiente`);
  } catch (e) {
    console.error("[resend] falha ao semear domínios:", (e as Error)?.name);
  }
  try {
    const aviso = await mensagemPrimeiroAcesso(
      o.sql,
      config.host,
      config.inviteCode,
    );
    if (aviso) log(aviso);
  } catch (e) {
    console.error(
      "primeiro acesso: falha ao verificar passkeys:",
      (e as Error)?.name,
    );
  }

  const pushDeps = pushDepsPadrao(o.sql, config);
  const agora = () => new Date();
  const registro = criarRegistrador(o.sql);
  // sem OPENROUTER_API_KEY o classificador fica desligado (sem selo)
  const classificador = criarClassificador({
    sql: o.sql,
    apiKey: config.openrouterKey,
  });
  const notificacao: NotificarDeps = {
    sql: o.sql,
    agora,
    enviar: (p) => enviarPush(p, pushDeps),
  };
  const vigia = new GerenciadorCaixas({
    sql: o.sql,
    masterKey: config.masterKey,
    mail: config,
    registro,
    notificar: (tipo, id, p, opc) => notificar(tipo, id, p, notificacao, opc),
    classificar: (id, pasta, uv, uid, email) =>
      classificador.classificar(id, pasta, uv, uid, email),
  });
  // um pool só (mutex por caixa) para as rotas e o worker da Caixa de saída
  const pool = criarPool({
    sql: o.sql,
    masterKey: config.masterKey,
    mail: config,
  });
  const fila = filaPadrao({
    sql: o.sql,
    masterKey: config.masterKey,
    mail: config,
    pool,
    agora,
    notificacao,
    resend: config.resend,
    registro,
  });
  const api = criarApp({
    sql: o.sql,
    agora,
    webauthn: webauthnDepsPadrao(o.sql, config),
    vapidPublic: config.vapidPublic,
    masterKey: config.masterKey,
    mail: config,
    enviarPush: notificacao.enviar,
    classificador,
    vigia,
    iaDisponivel: !!config.openrouterKey,
    pool,
    fila,
    resend: config.resend,
    registro,
  });
  return { app: montarEstatico(api, o.dirPublico), config, vigia, fila };
}

async function principal() {
  const { app, vigia, fila } = await iniciar({
    env: Deno.env.toObject(),
    sql: sqlPadrao,
    dirDados: Deno.env.get("CORREIO_DATA_DIR") ?? DIR_DADOS_PADRAO,
    dirPublico: Deno.env.get("CORREIO_PUBLIC_DIR") ?? DIR_PUBLICO_PADRAO,
  });
  const port = Number(Deno.env.get("PORT") ?? 8000);
  const servidor = Deno.serve({ port }, app.fetch);

  // Job diário: remove linhas de registro com mais de 30 dias.
  const limparRegistro = async () => {
    try {
      const n = await trimRegistro(sqlPadrao);
      if (n) {
        console.log(`[registro] ${n} linhas com mais de 30 dias removidas`);
      }
    } catch (e) {
      console.error("[registro] limpeza diária falhou:", (e as Error)?.name);
    }
  };
  void limparRegistro();
  const timerRegistro = setInterval(
    () => void limparRegistro(),
    24 * 60 * 60_000,
  );

  // SIGTERM (deploy/restart): fecha os vigias (LOGOUT IMAP), espera os
  // pushes em voo e encerra o HTTP.
  let encerrando = false;
  const encerrar = async () => {
    if (encerrando) return;
    encerrando = true;
    clearInterval(timerRegistro);
    console.log("encerrando: parando vigias de caixa…");
    const prazo = new Promise((r) => setTimeout(r, 15_000));
    await Promise.race([
      (async () => {
        await vigia.stop();
        await fila.parar();
        await aguardarNotificacoes();
        await servidor.shutdown();
        await sqlPadrao.end({ timeout: 5 });
      })().catch((e) => console.error("encerramento:", (e as Error)?.name)),
      prazo,
    ]);
    Deno.exit(0);
  };
  // registrados antes do start: um SIGTERM durante a conexão inicial das
  // caixas já encerra os vigias com LOGOUT
  for (const sinal of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(sinal, () => void encerrar());
  }
  fila.iniciar();
  await vigia.start();
}

if (import.meta.main) {
  await principal();
}
