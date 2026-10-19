import { loadConfig } from "./src/config.ts";
import { sql } from "./src/db/client.ts";
import { migrate } from "./src/db/migrate.ts";
import { createCfApi } from "./src/cloudflare/client.ts";
import { sincronizarZonas, zonasMonitoradas } from "./src/cloudflare/zonas.ts";
import { executarColeta } from "./src/monitor/collector.ts";
import {
  bloquear,
  desfazer,
  type ExecutorDeps,
  expirarVencidos,
  garantirInfra,
  prorrogar,
} from "./src/monitor/executor.ts";
import {
  garantirConector,
  modoViagemAtual,
  reaplicarGeoAtual,
  semearExcecoesPadrao,
} from "./src/monitor/geoblock.ts";
import { atualizarVendores } from "./src/monitor/vendores.ts";
import { criarVerificadorBots } from "./src/monitor/bots.ts";
import { sincronizarProtecoes } from "./src/monitor/protecoes.ts";
import { type Deps as IaDeps } from "./src/ai/openrouter.ts";
import { decidir, testarPapel } from "./src/ai/decisions.ts";
import { monitorarTrafego, triar } from "./src/ai/triage.ts";
import { investigar } from "./src/ai/investigate.ts";
import {
  depsPadrao as notifDepsPadrao,
  type Notificacao,
  notificar,
  type TipoEvento,
} from "./src/notify/notifier.ts";
import { depsPadrao as webauthnDepsPadrao } from "./src/auth/webauthn.ts";
import { criarApp, type Operacoes } from "./src/api/routes.ts";
import { iniciarScheduler } from "./src/scheduler.ts";
import { criarJobAlertasHost, criarServidor } from "./src/host/servidor.ts";
import { localizarIp, provedorIpwhois } from "./src/ip/localizar.ts";
import { DIR_PUBLICO_PADRAO, montarEstatico } from "./src/http/estatico.ts";
import { criarClienteAuditoria } from "./src/auditoria/verificacoes.ts";
import {
  auditarHostProfundo,
  criarClienteRede,
} from "./src/auditoria/varredura.ts";
import {
  type Campanha,
  executarCampanhaSegura,
} from "./src/auditoria/ataque.ts";
import {
  criarExecutorAuditoria,
  executarAuditoria,
  listarAchados,
} from "./src/auditoria/execucao.ts";
import { type EntradaRevisao, rodarRevisao } from "./src/auditoria/revisor.ts";
import {
  analisarRepo,
  baixarZipGithub,
  extrairZip,
  githubZip,
} from "./src/auditoria/codigo.ts";
import { sincronizarCabecalhos } from "./src/monitor/cabecalhos.ts";
import {
  auditarSupabase,
  listarInstancias as listarSupabaseInstancias,
  salvarResultado as salvarSupabaseResultado,
} from "./src/auditoria/supabase.ts";
import { descobrirIpServidor } from "./src/monitor/ip_servidor.ts";
import { criarClienteEasypanel } from "./src/easypanel/cliente.ts";
import {
  criarMonitorEasypanel,
  listarApps,
  validarTokenEasypanel,
} from "./src/easypanel/monitor.ts";
import {
  DIR_DADOS_PADRAO,
  garantirSegredos,
  mensagemPrimeiroAcesso,
} from "./src/segredos.ts";

async function principal() {
  const env = await garantirSegredos(
    Deno.env.toObject(),
    Deno.env.get("VIGIA_DATA_DIR") ?? DIR_DADOS_PADRAO,
  );
  const config = loadConfig(env);
  const agora = () => new Date();

  await migrate(sql);
  await semearExcecoesPadrao(sql);
  try {
    const aviso = await mensagemPrimeiroAcesso(
      sql,
      config.vigiaHost,
      config.inviteCode,
    );
    if (aviso) console.log(aviso);
  } catch (e) {
    console.error("primeiro acesso: falha ao verificar passkeys:", e);
  }

  const api = createCfApi(config);
  const exec: ExecutorDeps = {
    api,
    sql,
    cfg: config,
    agora,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  /** Regra "Vigia: proteções" + rate limiting; nunca lança por zona. */
  const aplicarProtecoes = async () =>
    sincronizarProtecoes(exec, await zonasMonitoradas(sql));
  /** Sincroniza zonas da conta e garante lista/regras do Vigia. */
  const sincronizarInfra = async (): Promise<{ zonasComFalha: string[] }> => {
    try {
      const z = await sincronizarZonas(api, sql);
      console.log(`zonas: ${z.total} na conta, ${z.novas} novas`);
    } catch (e) {
      console.error("zonas: falha ao sincronizar com o Cloudflare:", e);
    }
    const zonas = await zonasMonitoradas(sql);
    const { zonasComFalha } = await garantirInfra(exec, zonas);
    if (zonasComFalha.length) {
      console.error(
        `infra: regra de bloqueio falhou nas zonas ${zonasComFalha.join(", ")}`,
      );
    }
    // Busca as faixas de egress dos vendedores (OpenAI/Codex) — mudam, então o
    // Vigia as atualiza antes de montar a regra. Falha de rede não derruba nada
    // (a faixa da Anthropic é embutida e as faixas já guardadas permanecem).
    try {
      const v = await atualizarVendores(sql);
      console.log(
        `vendores: ${v.map((x) => `${x.vendor}=${x.erro ?? x.faixas}`).join(", ")}`,
      );
    } catch (e) {
      console.error("vendores: falha ao atualizar:", e);
    }
    // Garante que o conector MCP / admin (Anthropic embutida + vendedores +
    // decisões) nunca leve 403 da WAF gerenciada da Cloudflare — reaplicada a
    // cada subida, sem depender de "permitidos".
    try {
      const c = await garantirConector(exec, zonas);
      if (c.zonasComFalha.length) {
        console.error(
          `conector: skip falhou nas zonas ${c.zonasComFalha.join(", ")}`,
        );
      }
    } catch (e) {
      console.error("conector: falha ao garantir regra de skip:", e);
    }
    try {
      const st = await aplicarProtecoes();
      const ruins = st.filter((z) => z.regra === "erro" || z.rate === "erro");
      if (ruins.length) {
        console.error(
          `protecoes: falha nas zonas ${ruins.map((z) => z.zona).join(", ")}`,
        );
      }
    } catch (e) {
      console.error("protecoes: falha ao aplicar:", e);
    }
    return { zonasComFalha };
  };
  try {
    await sincronizarInfra();
  } catch (e) {
    console.error("infra: falha ao garantir lista/regras do Vigia:", e);
  }

  const notifDeps = notifDepsPadrao(sql, config);
  const avisar = (tipo: TipoEvento, n: Notificacao) =>
    notificar(tipo, n, notifDeps);
  const ia: IaDeps = {
    fetch,
    sql,
    cfg: config,
    agora,
    aoDegradar: async (_papel, modelo) => {
      await avisar("modelo_degradado", {
        titulo: `Modelo ${modelo} lento/fora`,
        corpo: "Substitua em Configurações → IAs",
        url: "/config",
      });
    },
  };

  // Auditoria dos sites: um cliente só (limite de 1 req/s por host vale entre
  // execuções) e uma execução por vez (agendada às 06:00 SP ou "rodar agora").
  const clienteAuditoria = criarClienteAuditoria();
  const clienteRede = criarClienteRede();
  const auditoria = criarExecutorAuditoria({
    sql,
    agora,
    executar: () =>
      executarAuditoria({
        sql,
        agora,
        auditar: (host) =>
          auditarHostProfundo(host, clienteAuditoria, clienteRede, agora()),
        notificar: avisar,
        antes: () => descobrirIpServidor({ sql, agora }),
      }),
  });

  // Apps do EasyPanel: só com EASYPANEL_URL + EASYPANEL_TOKEN (a cada 2 min).
  let monitorApps: (() => Promise<unknown>) | undefined;
  if (config.easypanel) {
    try {
      const cliente = criarClienteEasypanel(config.easypanel);
      // Valida o token na partida (auth/getUser): "token inválido" na aba Apps.
      await validarTokenEasypanel({ sql, agora, cliente });
      monitorApps = criarMonitorEasypanel({
        sql,
        agora,
        cliente,
        notificar: avisar,
      });
    } catch (e) {
      console.error("easypanel: configuração inválida:", (e as Error).message);
    }
  } else {
    console.log("easypanel: não configurado (EASYPANEL_URL/EASYPANEL_TOKEN)");
  }

  // Revisor IA (caixa-preta): análise autônoma dos achados + apps, com o papel
  // de IA dedicado "revisor". Uma por vez; dispara em segundo plano.
  let revisaoEmAndamento = false;
  const coletarEntradaRevisao = async (): Promise<EntradaRevisao> => ({
    achados: await listarAchados(sql),
    apps: config.easypanel ? await listarApps(sql).catch(() => []) : [],
  });
  const dispararRevisao = async (
    entrada?: EntradaRevisao,
  ): Promise<{ estado: "iniciada" | "ja_rodando" }> => {
    if (revisaoEmAndamento) return { estado: "ja_rodando" };
    revisaoEmAndamento = true;
    (async () => {
      try {
        const e = entrada ?? await coletarEntradaRevisao();
        const r = await rodarRevisao(ia, e);
        if (
          r.ok &&
          r.achados.some((a) =>
            a.severidade === "critica" || a.severidade === "alta"
          )
        ) {
          const altas = r.achados.filter((a) =>
            a.severidade === "critica" || a.severidade === "alta"
          ).length;
          await avisar("revisao_ia", {
            titulo: `Revisor IA: ${altas} achado(s) de alto risco`,
            corpo: r.resumo.slice(0, 300),
            url: "/auditoria",
          });
        }
      } catch (e) {
        console.error("revisor:", (e as Error)?.message ?? e);
      } finally {
        revisaoEmAndamento = false;
      }
    })();
    return { estado: "iniciada" };
  };

  // Análise de código (zip/GitHub) pelo Revisor IA: uma por vez, em 2º plano.
  // Só leitura do fonte; nunca executa o código do alvo.
  let codigoEmAndamento = false;
  const dispararAnaliseCodigo = async (
    origem:
      | { tipo: "github"; url: string }
      | { tipo: "zip"; nome: string; bytes: Uint8Array },
  ): Promise<{ estado: "iniciada" | "ja_rodando" }> => {
    if (codigoEmAndamento) return { estado: "ja_rodando" };
    codigoEmAndamento = true;
    (async () => {
      try {
        let repo: string, origemStr: string, bytes: Uint8Array;
        if (origem.tipo === "github") {
          const alvo = githubZip(origem.url);
          bytes = await baixarZipGithub(alvo.zipUrl, {
            token: Deno.env.get("GITHUB_TOKEN") || undefined,
          });
          repo = alvo.repo;
          origemStr = `github:${alvo.owner}/${alvo.repo}`;
        } else {
          bytes = origem.bytes;
          repo = origem.nome.replace(/\.zip$/i, "");
          origemStr = `zip:${origem.nome}`;
        }
        const arquivos = extrairZip(bytes);
        if (arquivos.length === 0) {
          console.error("codigo: nenhum arquivo de código no zip");
          return;
        }
        const r = await analisarRepo(ia, repo, origemStr, arquivos);
        if (
          r.ok &&
          r.achados.some((a) =>
            a.severidade === "critica" || a.severidade === "alta"
          )
        ) {
          const altas = r.achados.filter((a) =>
            a.severidade === "critica" || a.severidade === "alta"
          ).length;
          await avisar("revisao_codigo", {
            titulo: `Revisor (código) em ${repo}: ${altas} de alto risco`,
            corpo: r.resumo.slice(0, 300),
            url: "/auditoria",
          });
        }
      } catch (e) {
        console.error("codigo:", (e as Error)?.message ?? e);
      } finally {
        codigoEmAndamento = false;
      }
    })();
    return { estado: "iniciada" };
  };

  // Auditoria anônima do Supabase: roda as instâncias cadastradas, uma vez por
  // vez, em segundo plano. Só GET/settings; nunca executa RPC nem lê dado.
  let supabaseEmAndamento = false;
  const dispararSupabase = async (): Promise<
    { estado: "iniciada" | "ja_rodando" | "sem_instancia" }
  > => {
    if (supabaseEmAndamento) return { estado: "ja_rodando" };
    const instancias = await listarSupabaseInstancias(sql);
    if (instancias.length === 0) return { estado: "sem_instancia" };
    supabaseEmAndamento = true;
    (async () => {
      try {
        for (const inst of instancias) {
          const r = await auditarSupabase(inst, fetch);
          await salvarSupabaseResultado(sql, r);
          const altos = r.achados.filter((a) =>
            a.severidade === "critica" || a.severidade === "alta"
          );
          if (altos.length > 0) {
            await avisar("supabase_achado", {
              titulo:
                `Supabase ${r.instancia}: ${altos.length} achado(s) alto/crítico`,
              corpo: altos.map((a) => a.titulo).slice(0, 5).join("\n"),
              url: "/supabase",
            });
          }
        }
      } catch (e) {
        console.error("supabase:", (e as Error)?.message ?? e);
      } finally {
        supabaseEmAndamento = false;
      }
    })();
    return { estado: "iniciada" };
  };

  // Um provedor para o push e para as telas (ipwho.is, cache de 7 dias).
  const geoIp = provedorIpwhois();
  const ops: Operacoes = {
    bloquear: (ip, inc, motivo, ator, dias) =>
      bloquear(exec, ip, inc, motivo, ator, dias),
    desfazer: (id, ator) => desfazer(exec, id, ator),
    prorrogar: (id, dias, ator) => prorrogar(exec, id, dias, ator),
    reaplicarGeo: () => reaplicarGeoAtual(exec),
    modoViagem: (ip, horas) => modoViagemAtual(exec, ip, horas),
    investigar: (id) => investigar(id, ia),
    testarModelo: (papel) => testarPapel(papel, ia),
    notificar: avisar,
    aplicarProtecoes,
    rodarAuditoria: () => auditoria.disparar(),
    auditoriaRodando: () => auditoria.rodando(),
    rodarRevisao: (entrada) => dispararRevisao(entrada),
    revisaoRodando: () => revisaoEmAndamento,
    analisarRepo: (origem) => dispararAnaliseCodigo(origem),
    revisaoCodigoRodando: () => codigoEmAndamento,
    aplicarCabecalhos: async (modo) =>
      sincronizarCabecalhos(api, modo, await zonasMonitoradas(sql)),
    auditarSupabase: () => dispararSupabase(),
    supabaseRodando: () => supabaseEmAndamento,
    reaplicarConector: async () =>
      (await garantirConector(exec, await zonasMonitoradas(sql))).zonasComFalha,
    easypanelConfigurado: () => monitorApps !== undefined,
    // Checagens ATIVAS SEGURAS contra o próprio staging (gate já aplicado).
    // Nada destrutivo: só GET malformado, varredura e teste do próprio rate
    // limit de login com credenciais falsas e o UA da auditoria.
    executarAtaque: (c: Campanha) =>
      executarCampanhaSegura(c, {
        http: clienteAuditoria,
        rede: clienteRede,
        tentarLogin: async (url) => {
          const r = await fetch(url, {
            method: "POST",
            redirect: "manual",
            headers: {
              "User-Agent":
                "Vigia-Auditoria/1.0 (+https://vigia.judinfo.com.br)",
              "Content-Type": "application/json",
            },
            // Credenciais FALSAS; nunca credenciais reais.
            body: JSON.stringify({
              email: "vigia-ratelimit-test@invalid.example",
              password: "senha-invalida-de-teste",
            }),
            signal: AbortSignal.timeout(10_000),
          });
          return { status: r.status };
        },
      }),
  };

  iniciarScheduler({
    ciclo: {
      sql,
      agora,
      coletar: () => executarColeta({ api, sql, agora }),
      triar: (incs, evs) => triar(incs, evs, ia, undefined, { decidir }),
      bloquear: (ip, inc, motivo, dias, regra) =>
        bloquear(
          exec,
          ip,
          inc,
          motivo,
          regra ? `ia:${regra}` : "ia",
          dias ?? 7,
        ),
      localizar: (ip) => localizarIp(sql, geoIp, ip, agora()),
      notificar: avisar,
      ehBotVerificado: criarVerificadorBots(),
      vigiaHost: config.vigiaHost,
      monitorar: (evs) => monitorarTrafego(evs, ia, undefined, { decidir }),
    },
    hora: {
      sql,
      agora,
      reaplicarGeo: () => reaplicarGeoAtual(exec),
      expirarVencidos: () => expirarVencidos(exec),
      garantirInfra: sincronizarInfra,
      notificar: avisar,
      descobrirIpServidor: () => descobrirIpServidor({ sql, agora }),
    },
    diario: { sql, agora },
    auditoria: {
      sql,
      agora,
      // Auditoria diária e, logo depois, o Revisor IA autônomo sobre o resultado.
      rodar: async () => {
        const r = await auditoria.rodar();
        dispararRevisao().catch(() => {});
        return r;
      },
    },
    easypanel: monitorApps,
    servidor: criarJobAlertasHost({
      servidor: criarServidor({ sql }),
      notificar: (a) =>
        avisar("servidor", {
          titulo: a.titulo,
          corpo: a.corpo,
          url: "/servidor",
          chaveAgregacao: a.chave,
        }),
    }),
  });

  const apiHttp = criarApp({
    sql,
    agora,
    webauthn: webauthnDepsPadrao(sql, config),
    ops,
    vapidPublic: config.vapidPublic,
    vigiaHost: config.vigiaHost,
    geoIp,
  });
  // API + PWA (pwa/dist) no mesmo processo; sem o dir, só a API.
  const app = montarEstatico(
    apiHttp,
    Deno.env.get("VIGIA_PUBLIC_DIR") ?? DIR_PUBLICO_PADRAO,
  );
  const port = Number(Deno.env.get("PORT") ?? 8000);
  Deno.serve({ port }, app.fetch);
}

if (import.meta.main) {
  await principal();
}
