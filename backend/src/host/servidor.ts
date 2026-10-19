// Fachada do "Servidor": telemetria do host, SMART (via SSH), teste de disco
// e comandos SSH da lista fechada. Usada pelo PWA, pela API v1 e pelo MCP, e
// pelo job de alertas do scheduler.
import type { Sql } from "../db/client.ts";
import { rodarBench } from "./bench.ts";
import { resumirSmart, suspeitaQlcSemDram } from "./smart.ts";
import {
  catalogo,
  configSsh,
  ErroSsh,
  executarSsh,
  infoChave,
  type ResultadoSsh,
} from "./ssh.ts";
import {
  type AlertaHost,
  avaliarAlertas,
  discosFisicos,
  LIMITES_PADRAO,
  lerTelemetria,
  type Telemetria,
} from "./telemetria.ts";

const DIR_DADOS = Deno.env.get("VIGIA_DATA_DIR") ?? "/data";
const INTERVALO_BENCH_MS = 10 * 60_000;

async function auditar(sql: Sql | undefined, ator: string, acao: string, alvo: string | null, detalhes: Record<string, unknown>) {
  if (!sql) return;
  try {
    await sql`INSERT INTO vigia.auditoria (ator, acao, alvo, detalhes)
      VALUES (${ator}, ${acao}, ${alvo}, ${sql.json(detalhes as never)})`;
  } catch (e) {
    console.error("servidor: auditoria falhou:", (e as Error).message);
  }
}

async function exec(cmd: string, args: string[]) {
  try {
    const o = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).output();
    return { code: o.code, stderr: new TextDecoder().decode(o.stderr) };
  } catch (e) {
    return { code: 127, stderr: String((e as Error).message) };
  }
}

export type Servidor = ReturnType<typeof criarServidor>;

export function criarServidor(d: { sql?: Sql } = {}) {
  let cache: { em: number; t: Telemetria } | null = null;
  let benchRodando = false;
  let ultimoBench: { em: number; r: unknown } | null = null;

  const s = {
    async telemetria(): Promise<Telemetria> {
      if (cache && Date.now() - cache.em < 5_000) return cache.t;
      const t = await lerTelemetria();
      cache = { em: Date.now(), t };
      return t;
    },

    async resumo() {
      const t = await s.telemetria();
      const ssh = configSsh();
      return {
        telemetria: t,
        alertas: avaliarAlertas(t),
        limites: LIMITES_PADRAO,
        ssh: { configurado: !!ssh.host, host: ssh.host, usuario: ssh.usuario, porta: ssh.porta },
        ultimoTesteDisco: ultimoBench ? { em: new Date(ultimoBench.em).toISOString(), resultado: ultimoBench.r } : null,
      };
    },

    /** SMART de todos os discos físicos, lido pelo SSH (o container não acessa /dev). */
    async smart(ator = "sistema") {
      const discos = await discosFisicos();
      if (!configSsh().host) {
        return {
          ok: false,
          erro: "SMART precisa do SSH do Vigia ao servidor (o container não acessa os discos). Configure em servidor_chave_ssh.",
          discos: discos.map((dispositivo) => ({ dispositivo })),
        };
      }
      const out = [];
      for (const dev of discos) {
        const r = await executarSsh("smart", { disco: dev });
        // smartctl usa bits do código de saída para avisos; o JSON vem mesmo assim.
        try {
          const j = JSON.parse(r.saida || "{}");
          if (!j.device && !j.model_name && r.erro) throw new Error(r.erro);
          const resumo = resumirSmart(j, dev);
          const q = suspeitaQlcSemDram(resumo.modelo);
          if (q) resumo.avisos.push(q);
          out.push(resumo);
        } catch (e) {
          out.push({ dispositivo: dev, erro: r.erro ?? (e as Error).message });
        }
      }
      await auditar(d.sql, ator, "servidor_smart", null, { discos: discos.length });
      return { ok: true, discos: out };
    },

    /** Teste de leitura/gravação num arquivo temporário em /data (disco dos volumes). */
    async testeDisco(mb = 512, ator = "sistema") {
      if (benchRodando) return { erro: "Já há um teste de disco em andamento." };
      if (ultimoBench && Date.now() - ultimoBench.em < INTERVALO_BENCH_MS) {
        return {
          erro: "Aguarde 10 minutos entre testes de disco (o teste pesa no disco de produção).",
          ultimo: ultimoBench.r,
        };
      }
      benchRodando = true;
      try {
        const r = await rodarBench(exec, DIR_DADOS, Math.min(Math.max(Number(mb) || 512, 64), 2048), (p) => Deno.remove(p));
        ultimoBench = { em: Date.now(), r };
        await auditar(d.sql, ator, "servidor_teste_disco", null, { mb, resultado: r });
        return r;
      } finally {
        benchRodando = false;
      }
    },

    async comando(nome: string, params: Record<string, unknown>, ator: string): Promise<ResultadoSsh> {
      const r = await executarSsh(nome, params);
      await auditar(d.sql, ator, "servidor_comando", nome, {
        params,
        ok: r.ok,
        codigo: r.codigo,
        ms: r.ms,
        erro: r.erro,
      });
      return r;
    },

    async chave() {
      return await infoChave();
    },

    catalogo,
  };
  return s;
}

export { ErroSsh };

/** Job do scheduler: lê o servidor e avisa o que persistir em 2 leituras seguidas. */
export function criarJobAlertasHost(dep: {
  servidor: Servidor;
  notificar: (a: AlertaHost) => Promise<unknown>;
}) {
  const seguidos = new Map<string, number>();
  return async () => {
    const t = await dep.servidor.telemetria();
    const agora = new Set<string>();
    for (const a of avaliarAlertas(t)) {
      agora.add(a.chave);
      const n = (seguidos.get(a.chave) ?? 0) + 1;
      seguidos.set(a.chave, n);
      if (n === 2) await dep.notificar(a); // persistiu ~2 ciclos; o notificador ainda agrega por janela
    }
    for (const k of [...seguidos.keys()]) if (!agora.has(k)) seguidos.delete(k);
    return { alertas: agora.size };
  };
}
