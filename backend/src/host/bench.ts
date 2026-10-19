// Teste de velocidade de disco com `dd`, num ARQUIVO temporário dentro de um
// diretório montado (nunca no disco bruto). Grava e lê com O_DIRECT quando
// possível (burla o cache de página e mede o disco de verdade); se o filesystem
// não aceitar direct, repete sem ele e marca `cacheado: true`. Apaga o arquivo
// ao final, sempre.

export interface ResultadoBench {
  caminho: string;
  tamanhoMb: number;
  escritaMbs: number | null;
  leituraMbs: number | null;
  cacheado: boolean;
  erro?: string;
}

type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stderr: string }>;

// dd imprime a taxa em stderr: "... copied, 1.23 s, 456 MB/s"
function taxaMbs(stderr: string): number | null {
  const m = stderr.match(/,\s*([\d.,]+)\s*([kMG])B\/s/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  const u = m[2];
  const mult = u === "G" ? 1024 : u === "k" ? 1 / 1024 : 1;
  return Math.round(v * mult * 10) / 10;
}

export async function rodarBench(
  exec: Exec,
  diretorio: string,
  tamanhoMb: number,
  apagar: (p: string) => Promise<void>,
): Promise<ResultadoBench> {
  const mb = Math.min(Math.max(tamanhoMb, 64), 4096); // 64 MB .. 4 GB
  const caminho = `${diretorio.replace(/\/$/, "")}/.vigia-bench-${Date.now()}.tmp`;
  const base: ResultadoBench = {
    caminho,
    tamanhoMb: mb,
    escritaMbs: null,
    leituraMbs: null,
    cacheado: false,
  };
  try {
    // ---- escrita ----
    let w = await exec("dd", [
      "if=/dev/zero",
      `of=${caminho}`,
      "bs=1M",
      `count=${mb}`,
      "oflag=direct",
      "conv=fsync",
    ]);
    if (w.code !== 0 && /direct|Invalid argument/i.test(w.stderr)) {
      base.cacheado = true;
      w = await exec("dd", [
        "if=/dev/zero",
        `of=${caminho}`,
        "bs=1M",
        `count=${mb}`,
        "conv=fsync",
      ]);
    }
    if (w.code !== 0) {
      return { ...base, erro: `escrita falhou: ${w.stderr.slice(-200)}` };
    }
    base.escritaMbs = taxaMbs(w.stderr);

    // ---- leitura ----
    let r = await exec("dd", [
      `if=${caminho}`,
      "of=/dev/null",
      "bs=1M",
      "iflag=direct",
    ]);
    if (r.code !== 0 && /direct|Invalid argument/i.test(r.stderr)) {
      base.cacheado = true;
      r = await exec("dd", [`if=${caminho}`, "of=/dev/null", "bs=1M"]);
    }
    if (r.code === 0) base.leituraMbs = taxaMbs(r.stderr);

    return base;
  } finally {
    await apagar(caminho).catch(() => {});
  }
}
