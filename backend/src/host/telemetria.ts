// Telemetria do servidor lida de /proc e /sys do HOST, montados no container
// (EasyPanel → vigia → Mounts: /proc → /host/proc e /sys → /host/sys).
// Somente leitura. Sem o /host/proc, cai para o /proc do container: CPU,
// memória e discos continuam sendo do host (o Docker não isola esses
// arquivos), mas a rede passa a ser a do container — o resultado avisa.
import {
  lerTemperaturas,
  parseCpu,
  parseDiskstats,
  parseLoad,
  parseMem,
  parseNetDev,
  usoCpu,
  usoDiscos,
  usoRede,
} from "./proc.ts";

const INTERVALO_MS = 500;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ler = (p: string) => Deno.readTextFile(p);

async function existe(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

export interface FontesHost {
  proc: string;
  sys: string;
  /** /proc do host montado (true) ou /proc do container (false). */
  procDoHost: boolean;
  sysDoHost: boolean;
}

let fontesCache: FontesHost | null = null;

export async function fontesHost(): Promise<FontesHost> {
  if (fontesCache) return fontesCache;
  const procEnv = Deno.env.get("HOST_PROC") ?? "/host/proc";
  const sysEnv = Deno.env.get("HOST_SYS") ?? "/host/sys";
  const procDoHost = await existe(`${procEnv}/stat`);
  const sysDoHost = await existe(`${sysEnv}/class`);
  fontesCache = {
    proc: procDoHost ? procEnv : "/proc",
    sys: sysDoHost ? sysEnv : "/sys",
    procDoHost,
    sysDoHost,
  };
  return fontesCache;
}

/** Rede do host: /proc/1/net/dev do procfs do host (PID 1 = init do host). */
async function arquivoRede(f: FontesHost): Promise<{ caminho: string; doHost: boolean }> {
  if (f.procDoHost) {
    const p = `${f.proc}/1/net/dev`;
    try {
      await ler(p);
      return { caminho: p, doHost: true };
    } catch { /* sem permissão: cai para a rede vista pelo processo */ }
  }
  return { caminho: `${f.proc}/net/dev`, doHost: false };
}

export interface Telemetria {
  em: string;
  fontes: { procDoHost: boolean; sysDoHost: boolean; redeDoHost: boolean };
  avisos: string[];
  cpu: {
    usoPct: number;
    iowaitPct: number;
    nucleos: number;
    carga: { min1: number; min5: number; min15: number };
    cargaPorNucleo: number;
    saturado: boolean;
  };
  memoria: ReturnType<typeof parseMem>;
  discos: ReturnType<typeof usoDiscos>;
  volumes: { ponto: string; totalGb: number; usadoGb: number; usadoPct: number }[];
  rede: ReturnType<typeof usoRede>;
  temperaturas: { sensor: string; rotulo: string; celsius: number }[];
  tempoLigadoHoras: number | null;
}

/** Uso do sistema de arquivos onde ficam os dados do Vigia (/data = disco dos volumes Docker). */
function volumes(): Telemetria["volumes"] {
  const out: Telemetria["volumes"] = [];
  for (const ponto of ["/data"]) {
    try {
      // Deno não expõe statfs; o `df` (coreutils) já vem na imagem.
      const o = new Deno.Command("df", { args: ["-Pk", ponto], stdout: "piped", stderr: "null" })
        .outputSync();
      const linha = new TextDecoder().decode(o.stdout).trim().split("\n")[1];
      const p = linha?.trim().split(/\s+/) ?? [];
      const total = Number(p[1]), usado = Number(p[2]);
      if (Number.isFinite(total) && total > 0) {
        out.push({
          ponto: "disco dos volumes (/data)",
          totalGb: Math.round(total / 1024 / 1024),
          usadoGb: Math.round(usado / 1024 / 1024),
          usadoPct: Math.round((usado / total) * 1000) / 10,
        });
      }
    } catch { /* df indisponível */ }
  }
  return out;
}

export async function lerTelemetria(): Promise<Telemetria> {
  const f = await fontesHost();
  const rede = await arquivoRede(f);
  const P = f.proc;
  const [stat1, disk1, net1] = await Promise.all([
    ler(`${P}/stat`),
    ler(`${P}/diskstats`).catch(() => ""),
    ler(rede.caminho).catch(() => ""),
  ]);
  await dormir(INTERVALO_MS);
  const [stat2, disk2, net2, mem, load, uptime] = await Promise.all([
    ler(`${P}/stat`),
    ler(`${P}/diskstats`).catch(() => ""),
    ler(rede.caminho).catch(() => ""),
    ler(`${P}/meminfo`),
    ler(`${P}/loadavg`),
    ler(`${P}/uptime`).catch(() => ""),
  ]);

  const cpu = usoCpu(parseCpu(stat1), parseCpu(stat2));
  const nucleos = (stat2.match(/^cpu\d+ /gm) ?? []).length ||
    navigator.hardwareConcurrency || 1;
  const temperaturas = await lerTemperaturas(
    async () => {
      const hs: string[] = [];
      for await (const e of Deno.readDir(`${f.sys}/class/hwmon`)) {
        hs.push(`${f.sys}/class/hwmon/${e.name}`);
      }
      return hs;
    },
    ler,
    async (dir) => {
      const es: string[] = [];
      for await (const e of Deno.readDir(dir)) es.push(e.name);
      return es;
    },
  );
  const [m1, m5, m15] = parseLoad(load);
  const avisos: string[] = [];
  if (!f.procDoHost) {
    avisos.push(
      "Sem /host/proc montado: CPU, memória e discos são do servidor, mas a rede mostrada é a do container. Monte /proc em /host/proc (somente leitura).",
    );
  } else if (!rede.doHost) {
    avisos.push("A rede do host não pôde ser lida; mostrando a do container.");
  }
  if (!f.sysDoHost) {
    avisos.push("Sem /host/sys montado: temperaturas e lista de discos podem faltar.");
  }
  const up = Number(uptime.trim().split(/\s+/)[0]);
  return {
    em: new Date().toISOString(),
    fontes: { procDoHost: f.procDoHost, sysDoHost: f.sysDoHost, redeDoHost: rede.doHost },
    avisos,
    cpu: {
      usoPct: cpu.usoPct,
      iowaitPct: cpu.iowaitPct,
      nucleos,
      carga: { min1: m1, min5: m5, min15: m15 },
      cargaPorNucleo: Math.round((m1 / nucleos) * 100) / 100,
      // carga acima do nº de núcleos = fila de processos; com iowait alto, fila de disco.
      saturado: m1 > nucleos,
    },
    memoria: parseMem(mem),
    discos: usoDiscos(parseDiskstats(disk1), parseDiskstats(disk2), INTERVALO_MS),
    volumes: volumes(),
    rede: usoRede(parseNetDev(net1), parseNetDev(net2), INTERVALO_MS)
      .filter((r) => !/^(veth|br-|docker|vx|cali|flannel|cni)/.test(r.iface)),
    temperaturas,
    tempoLigadoHoras: Number.isFinite(up) ? Math.round(up / 360) / 10 : null,
  };
}

/** Discos físicos vistos em /sys/block (para o SMART). */
export async function discosFisicos(): Promise<string[]> {
  const f = await fontesHost();
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(`${f.sys}/block`)) {
      if (/^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+|xvd[a-z]+|hd[a-z]+)$/.test(e.name)) {
        out.push(`/dev/${e.name}`);
      }
    }
  } catch { /* sem /sys/block */ }
  return out.sort();
}

// ------------------------------------------------------------- alertas
export interface LimitesHost {
  tempC: number;
  memPct: number;
  swapPct: number;
  cargaPorNucleo: number;
  iowaitPct: number;
  discoUtilPct: number;
  volumePct: number;
}

export const LIMITES_PADRAO: LimitesHost = {
  tempC: 85,
  memPct: 92,
  swapPct: 60,
  cargaPorNucleo: 1.5,
  iowaitPct: 30,
  discoUtilPct: 95,
  volumePct: 90,
};

export interface AlertaHost {
  chave: string;
  titulo: string;
  corpo: string;
}

/** Regras de alerta sobre uma leitura (puras: testáveis sem /proc). */
export function avaliarAlertas(t: Telemetria, l: LimitesHost = LIMITES_PADRAO): AlertaHost[] {
  const a: AlertaHost[] = [];
  const quente = t.temperaturas.filter((x) => x.celsius >= l.tempC);
  if (quente.length) {
    const pior = quente.reduce((p, x) => (x.celsius > p.celsius ? x : p));
    a.push({
      chave: "host:temperatura",
      titulo: `Servidor quente: ${pior.celsius} °C`,
      corpo: `${pior.sensor} ${pior.rotulo} em ${pior.celsius} °C (limite ${l.tempC} °C). Verifique ventilação e poeira.`,
    });
  }
  if (t.memoria.usadaPct >= l.memPct) {
    a.push({
      chave: "host:memoria",
      titulo: `Memória do servidor em ${t.memoria.usadaPct}%`,
      corpo: `${t.memoria.usadaMb} de ${t.memoria.totalMb} MB em uso; disponível ${t.memoria.disponivelMb} MB.`,
    });
  }
  if (t.memoria.swapTotalMb > 0 && t.memoria.swapUsadaPct >= l.swapPct) {
    a.push({
      chave: "host:swap",
      titulo: `Swap em ${t.memoria.swapUsadaPct}%`,
      corpo: `O servidor está usando ${t.memoria.swapUsadaMb} MB de swap: falta memória e tudo fica lento.`,
    });
  }
  if (t.cpu.cargaPorNucleo >= l.cargaPorNucleo) {
    const disco = t.cpu.iowaitPct >= l.iowaitPct;
    a.push({
      chave: "host:carga",
      titulo: `Servidor saturado (carga ${t.cpu.carga.min1} em ${t.cpu.nucleos} núcleos)`,
      corpo: disco
        ? `Fila de processos com iowait de ${t.cpu.iowaitPct}%: o gargalo é o disco.`
        : `CPU em ${t.cpu.usoPct}%: o gargalo é processamento.`,
    });
  }
  for (const d of t.discos) {
    if (d.utilPct >= l.discoUtilPct) {
      a.push({
        chave: `host:disco:${d.nome}`,
        titulo: `Disco ${d.nome} no limite (${d.utilPct}% ocupado)`,
        corpo: `${d.leituraMbs} MB/s de leitura, ${d.escritaMbs} MB/s de escrita, ${d.iops} IOPS.`,
      });
    }
  }
  for (const v of t.volumes) {
    if (v.usadoPct >= l.volumePct) {
      a.push({
        chave: "host:espaco",
        titulo: `Disco quase cheio: ${v.usadoPct}%`,
        corpo: `${v.ponto}: ${v.usadoGb} de ${v.totalGb} GB usados.`,
      });
    }
  }
  return a;
}
