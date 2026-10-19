// Parsers de /proc e /sys (formatos estáveis do kernel Linux). Cada função
// recebe o TEXTO do arquivo — assim o parsing é testável sem acesso a /proc.
// Confirmado contra um Linux real em 2026-10-19 (campos e ordem).

export interface CpuTempos {
  total: number;
  ocioso: number; // idle + iowait
  iowait: number;
}

/** Primeira linha "cpu  user nice system idle iowait irq softirq steal ..." */
export function parseCpu(statText: string): CpuTempos {
  const linha = statText.split("\n").find((l) => l.startsWith("cpu "));
  if (!linha) throw new Error("linha 'cpu ' ausente em /proc/stat");
  const n = linha.trim().split(/\s+/).slice(1).map(Number);
  const [user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0,
    softirq = 0, steal = 0] = n;
  const total = user + nice + sys + idle + iowait + irq + softirq + steal;
  return { total, ocioso: idle + iowait, iowait };
}

/** Uso de CPU entre duas amostras de parseCpu, 0..100. */
export function usoCpu(a: CpuTempos, b: CpuTempos) {
  const dTotal = b.total - a.total;
  const dOcioso = b.ocioso - a.ocioso;
  const dIowait = b.iowait - a.iowait;
  if (dTotal <= 0) return { usoPct: 0, iowaitPct: 0 };
  return {
    usoPct: Math.round(((dTotal - dOcioso) / dTotal) * 1000) / 10,
    iowaitPct: Math.round((dIowait / dTotal) * 1000) / 10,
  };
}

export interface Memoria {
  totalMb: number;
  usadaMb: number;
  disponivelMb: number;
  cacheMb: number;
  swapTotalMb: number;
  swapUsadaMb: number;
  usadaPct: number;
  swapUsadaPct: number;
}

/** /proc/meminfo (valores em kB). "usada" = total - disponível, como o free. */
export function parseMem(text: string): Memoria {
  const m = new Map<string, number>();
  for (const l of text.split("\n")) {
    const mt = l.match(/^(\w+):\s+(\d+)\s*kB/);
    if (mt) m.set(mt[1], Number(mt[2]));
  }
  const kb = (k: string) => m.get(k) ?? 0;
  const totalKb = kb("MemTotal");
  // MemAvailable é a métrica correta de "livre real" (inclui cache recuperável).
  const dispKb = m.has("MemAvailable") ? kb("MemAvailable") : kb("MemFree");
  const usadaKb = Math.max(0, totalKb - dispKb);
  const swapTotalKb = kb("SwapTotal");
  const swapUsadaKb = Math.max(0, swapTotalKb - kb("SwapFree"));
  const mb = (x: number) => Math.round(x / 1024);
  return {
    totalMb: mb(totalKb),
    usadaMb: mb(usadaKb),
    disponivelMb: mb(dispKb),
    cacheMb: mb(kb("Cached") + kb("Buffers")),
    swapTotalMb: mb(swapTotalKb),
    swapUsadaMb: mb(swapUsadaKb),
    usadaPct: totalKb ? Math.round((usadaKb / totalKb) * 1000) / 10 : 0,
    swapUsadaPct: swapTotalKb
      ? Math.round((swapUsadaKb / swapTotalKb) * 1000) / 10
      : 0,
  };
}

/** /proc/loadavg -> [1min, 5min, 15min]. */
export function parseLoad(text: string): [number, number, number] {
  const p = text.trim().split(/\s+/).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

export interface DiscoAmostra {
  nome: string;
  leituras: number; // setores lidos
  escritas: number; // setores escritos
  msIo: number; // tempo com I/O em andamento (campo 10)
  leiturasN: number; // nº de operações de leitura concluídas
  escritasN: number;
}

// /proc/diskstats: major minor nome
//   campo 3 reads completed, 6 sectors read, 7 writes completed,
//   10 sectors written, 13 (índice) time spent doing I/O (ms).
// Índices 0-based após remover major/minor/nome: campos[0]=reads completed...
export function parseDiskstats(text: string): DiscoAmostra[] {
  const out: DiscoAmostra[] = [];
  for (const l of text.split("\n")) {
    const p = l.trim().split(/\s+/);
    if (p.length < 14) continue;
    const nome = p[2];
    // só discos inteiros: sd*, vd*, nvme*n*; ignora loop, zram e partições
    if (!/^(sd[a-z]+|vd[a-z]+|nvme\d+n\d+|xvd[a-z]+|hd[a-z]+)$/.test(nome)) {
      continue;
    }
    const c = p.slice(3).map(Number);
    out.push({
      nome,
      leiturasN: c[0],
      leituras: c[2],
      escritasN: c[4],
      escritas: c[6],
      msIo: c[9],
    });
  }
  return out;
}

export interface DiscoUso {
  nome: string;
  leituraMbs: number;
  escritaMbs: number;
  iops: number;
  utilPct: number; // % do tempo com I/O em andamento (como o %util do iostat)
}

/** Diferença entre duas amostras de diskstats num intervalo de `ms`. */
export function usoDiscos(
  a: DiscoAmostra[],
  b: DiscoAmostra[],
  ms: number,
): DiscoUso[] {
  const porNome = new Map(a.map((d) => [d.nome, d]));
  const seg = ms / 1000;
  const out: DiscoUso[] = [];
  for (const d2 of b) {
    const d1 = porNome.get(d2.nome);
    if (!d1 || seg <= 0) continue;
    const ops = (d2.leiturasN - d1.leiturasN) + (d2.escritasN - d1.escritasN);
    const mbPorSetor = 512 / 1024 / 1024; // setor de 512 bytes
    out.push({
      nome: d2.nome,
      leituraMbs:
        Math.round((d2.leituras - d1.leituras) * mbPorSetor / seg * 10) / 10,
      escritaMbs:
        Math.round((d2.escritas - d1.escritas) * mbPorSetor / seg * 10) / 10,
      iops: Math.round(ops / seg),
      utilPct: Math.min(100, Math.round((d2.msIo - d1.msIo) / ms * 1000) / 10),
    });
  }
  return out;
}

export interface RedeAmostra {
  iface: string;
  rxBytes: number;
  txBytes: number;
}

/** /proc/net/dev */
export function parseNetDev(text: string): RedeAmostra[] {
  const out: RedeAmostra[] = [];
  for (const l of text.split("\n")) {
    const mt = l.match(/^\s*([\w.-]+):\s*(.+)$/);
    if (!mt) continue;
    const iface = mt[1];
    if (iface === "lo") continue;
    const n = mt[2].trim().split(/\s+/).map(Number);
    out.push({ iface, rxBytes: n[0], txBytes: n[8] });
  }
  return out;
}

export function usoRede(a: RedeAmostra[], b: RedeAmostra[], ms: number) {
  const porIface = new Map(a.map((r) => [r.iface, r]));
  const seg = ms / 1000;
  return b.map((r2) => {
    const r1 = porIface.get(r2.iface);
    const mbs = (delta: number) =>
      r1 && seg > 0 ? Math.round(delta / 1024 / 1024 / seg * 100) / 100 : 0;
    return {
      iface: r2.iface,
      rxMbs: r1 ? mbs(r2.rxBytes - r1.rxBytes) : 0,
      txMbs: r1 ? mbs(r2.txBytes - r1.txBytes) : 0,
    };
  });
}

/** Lê temperaturas de /sys/class/hwmon/*. `ler` injeta o acesso a arquivo. */
export async function lerTemperaturas(
  listarHwmon: () => Promise<string[]>,
  lerArquivo: (p: string) => Promise<string>,
  listarEntradas: (dir: string) => Promise<string[]>,
): Promise<{ sensor: string; rotulo: string; celsius: number }[]> {
  const out: { sensor: string; rotulo: string; celsius: number }[] = [];
  let hwmons: string[];
  try {
    hwmons = await listarHwmon();
  } catch {
    return out;
  }
  for (const h of hwmons) {
    let nome = h;
    try {
      nome = (await lerArquivo(`${h}/name`)).trim() || h;
    } catch { /* sem nome */ }
    let entradas: string[];
    try {
      entradas = await listarEntradas(h);
    } catch {
      continue;
    }
    for (const e of entradas) {
      const mt = e.match(/^temp(\d+)_input$/);
      if (!mt) continue;
      try {
        const milic = Number(await lerArquivo(`${h}/${e}`));
        if (!Number.isFinite(milic)) continue;
        let rotulo = `temp${mt[1]}`;
        try {
          rotulo = (await lerArquivo(`${h}/temp${mt[1]}_label`)).trim() || rotulo;
        } catch { /* sem label */ }
        out.push({ sensor: nome, rotulo, celsius: Math.round(milic / 100) / 10 });
      } catch { /* sensor ilegível */ }
    }
  }
  return out;
}
