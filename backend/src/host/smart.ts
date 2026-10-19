// SMART via `smartctl --json`. Resume o que importa para decidir hardware:
// modelo, se é SSD, se é QLC/sem DRAM (heurística), desgaste, dados gravados,
// temperatura e saúde. O parsing recebe o JSON já desserializado, então é
// testável com amostras reais de `smartctl -iHAj /dev/X`.

export interface ResumoSmart {
  dispositivo: string;
  modelo: string | null;
  familia: string | null;
  serieParcial: string | null; // últimos 4, para identificar sem expor o nº
  capacidadeGb: number | null;
  rotacional: boolean | null; // true=HDD, false=SSD
  tipo: "HDD" | "SSD" | "NVMe" | "desconhecido";
  saudeOk: boolean | null;
  temperaturaC: number | null;
  desgastePct: number | null; // 0 = novo, 100 = fim da vida projetada
  dadosGravadosTb: number | null;
  ligadoHoras: number | null;
  realocados: number | null;
  avisos: string[];
}

function arredondar(n: number, casas = 1) {
  const f = 10 ** casas;
  return Math.round(n * f) / f;
}

// deno-lint-ignore no-explicit-any
export function resumirSmart(j: any, dispositivo: string): ResumoSmart {
  const avisos: string[] = [];
  const modelo = j?.model_name ?? j?.scsi_model_name ?? null;
  const rotRate = j?.rotation_rate; // 0 em SSD; ausente em alguns NVMe
  const ehNvme = typeof dispositivo === "string" && /nvme/.test(dispositivo) ||
    j?.device?.type === "nvme" || !!j?.nvme_smart_health_information_log;
  const rotacional = typeof rotRate === "number" ? rotRate > 0 : null;
  const tipo = ehNvme
    ? "NVMe"
    : rotacional === true
    ? "HDD"
    : rotacional === false
    ? "SSD"
    : "desconhecido";

  const capBytes = j?.user_capacity?.bytes;
  const capacidadeGb = typeof capBytes === "number"
    ? arredondar(capBytes / 1e9, 0)
    : null;

  const saudeOk = typeof j?.smart_status?.passed === "boolean"
    ? j.smart_status.passed
    : null;
  if (saudeOk === false) avisos.push("SMART reprovado: disco em risco de falha");

  const temperaturaC = typeof j?.temperature?.current === "number"
    ? j.temperature.current
    : null;

  // ---- atributos ATA (SATA) ou log NVMe ----
  let desgastePct: number | null = null;
  let dadosGravadosTb: number | null = null;
  let ligadoHoras: number | null = typeof j?.power_on_time?.hours === "number"
    ? j.power_on_time.hours
    : null;
  let realocados: number | null = null;

  const nvme = j?.nvme_smart_health_information_log;
  if (nvme) {
    if (typeof nvme.percentage_used === "number") {
      desgastePct = nvme.percentage_used;
    }
    // data_units_written: unidades de 512 KB * 1000 bytes
    if (typeof nvme.data_units_written === "number") {
      dadosGravadosTb = arredondar(nvme.data_units_written * 512000 / 1e12, 2);
    }
    if (typeof nvme.power_on_hours === "number") ligadoHoras = nvme.power_on_hours;
  }

  const attrs = j?.ata_smart_attributes?.table;
  if (Array.isArray(attrs)) {
    // deno-lint-ignore no-explicit-any
    const porId = new Map<number, any>(attrs.map((a: any) => [a.id, a]));
    const porNome = (re: RegExp) =>
      // deno-lint-ignore no-explicit-any
      attrs.find((a: any) => re.test(a.name ?? ""));

    // Wear: 177/231/233 (varia por fabricante) — o "value" normalizado cai de
    // 100 a 0; desgaste = 100 - value. O 202/231 também aparece como "restante".
    const wear = porId.get(177) ?? porId.get(233) ?? porId.get(231) ??
      porNome(/Wear_Leveling|Media_Wearout|SSD_Life|Percent_Life/i);
    if (wear && typeof wear.value === "number" && desgastePct === null) {
      // alguns relatam "restante" (100->0), outros "usado"; assumimos restante
      desgastePct = Math.min(100, Math.max(0, 100 - wear.value));
    }

    // Total de dados escritos (241), em LBAs de 512 bytes na maioria.
    const lbaW = porId.get(241) ?? porNome(/Total_LBAs_Written|Host_Writes/i);
    if (lbaW && dadosGravadosTb === null) {
      const raw = Number(lbaW.raw?.value ?? lbaW.raw?.string?.split(" ")[0]);
      if (Number.isFinite(raw) && raw > 0) {
        dadosGravadosTb = arredondar(raw * 512 / 1e12, 2);
      }
    }

    const re = porId.get(5) ?? porNome(/Reallocated_Sector/i);
    if (re) realocados = Number(re.raw?.value ?? 0);
    if (realocados && realocados > 0) {
      avisos.push(`${realocados} setores realocados (sinal de desgaste do disco)`);
    }
  }

  if (desgastePct !== null && desgastePct >= 80) {
    avisos.push(`desgaste em ${desgastePct}% da vida projetada`);
  }
  if (temperaturaC !== null && temperaturaC >= 70) {
    avisos.push(`temperatura alta: ${temperaturaC} °C`);
  }

  const serie = j?.serial_number;
  return {
    dispositivo,
    modelo,
    familia: j?.model_family ?? null,
    serieParcial: typeof serie === "string" ? serie.slice(-4) : null,
    capacidadeGb,
    rotacional,
    tipo,
    saudeOk,
    temperaturaC,
    desgastePct,
    dadosGravadosTb,
    ligadoHoras,
    realocados,
    avisos,
  };
}

/** Heurística de QLC/sem DRAM: smartctl não expõe diretamente; inferência
 * leve pelo modelo. Serve de alerta, não de verdade absoluta. */
export function suspeitaQlcSemDram(modelo: string | null): string | null {
  if (!modelo) return null;
  const m = modelo.toUpperCase();
  // Modelos DRAM-less/QLC populares em SSDs baratos de 1 TB.
  const qlc = /QLC|BX500|A400|AS350|SU630|SU635|GREEN|P3\b|P2\b|NV2\b|AR plus/i;
  if (qlc.test(m)) {
    return "Modelo costuma ser QLC e/ou sem cache DRAM: gravação contínua cai muito. Confirme a ficha técnica do fabricante.";
  }
  return null;
}
