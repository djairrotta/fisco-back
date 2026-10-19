import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { aspas, COMANDOS, ErroSsh, executarSsh, linhaAuthorizedKeys, linhaRemota } from "../src/host/ssh.ts";
import { avaliarAlertas, lerTelemetria, type Telemetria } from "../src/host/telemetria.ts";

Deno.test("aspas: aspas simples e escape de aspas internas", () => {
  assertEquals(aspas("abc"), "'abc'");
  assertEquals(aspas("a'b"), "'a'\\''b'");
  assertEquals(aspas("$(rm -rf /)"), "'$(rm -rf /)'");
});

Deno.test("linhaRemota: só comandos do catálogo, args citados, sudo para não-root", () => {
  const { linha } = linhaRemota("containers", {}, "vigia");
  assertEquals(linha, "'env' 'LC_ALL=C' 'docker' 'ps' '--format' '{{.Names}}\t{{.Status}}\t{{.Image}}'");
  assert(linhaRemota("smart", { disco: "/dev/sda" }, "vigia").linha.includes("'sudo' '-n' 'smartctl'"));
  assert(!linhaRemota("smart", { disco: "/dev/nvme0n1" }, "root").linha.includes("sudo"));
  assertThrows(() => linhaRemota("rm", {}, "vigia"), ErroSsh, "fora da lista");
  assertThrows(() => linhaRemota("constructor", {}, "vigia"), ErroSsh, "fora da lista");
  assertThrows(() => linhaRemota("smart", { disco: "/dev/sda; reboot" }, "vigia"), ErroSsh, "disco inválido");
  assertThrows(() => linhaRemota("container_logs", { container: "x;id" }, "vigia"), ErroSsh, "container inválido");
  assertThrows(() => linhaRemota("uptime", { extra: 1 }, "vigia"), ErroSsh, "não aceito");
  assert(linhaRemota("container_logs", { container: "funciona_iandamentoback.1.abc", linhas: 99999 }, "vigia").linha.includes("'500'"));
});

Deno.test("todos os comandos montam argv sem metacaracteres de shell fora das aspas", () => {
  for (const [nome, c] of Object.entries(COMANDOS)) {
    const p: Record<string, unknown> = {};
    if (c.parametros?.disco) p.disco = "/dev/sda";
    if (c.parametros?.container) p.container = "app";
    const { linha } = linhaRemota(nome, p, "vigia");
    // fora das aspas só pode haver espaços
    assertEquals(linha.replace(/'[^']*'/g, "").trim(), "", nome);
  }
});

Deno.test("executarSsh: sem SSH_HOST explica como configurar", async () => {
  await assertRejects(
    () => executarSsh("uptime", {}, { config: { host: null, porta: 22, usuario: "vigia", dir: "/tmp" }, exec: () => Promise.reject() }),
    ErroSsh,
    "não configurado",
  );
});

Deno.test("executarSsh: chama ssh com BatchMode e traduz chave recusada", async () => {
  let args: string[] = [];
  const r = await executarSsh("uptime", {}, {
    config: { host: "192.168.0.118", porta: 22, usuario: "vigia", dir: "/data/ssh" },
    exec: (cmd, a) => {
      assertEquals(cmd, "ssh");
      args = a;
      return Promise.resolve({ code: 255, stdout: "", stderr: "vigia@192.168.0.118: Permission denied (publickey).", tempoEsgotado: false });
    },
  });
  assert(args.includes("BatchMode=yes"));
  assertEquals(args.at(-1), "'env' 'LC_ALL=C' 'uptime'");
  assertEquals(args.at(-3), "vigia@192.168.0.118");
  assert(!r.ok);
  assert(r.erro?.includes("chave recusada"));
});

Deno.test("executarSsh: corta saída por linhas", async () => {
  const r = await executarSsh("processos", {}, {
    config: { host: "h", porta: 22, usuario: "vigia", dir: "/d" },
    exec: () => Promise.resolve({ code: 0, stdout: Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n"), stderr: "", tempoEsgotado: false }),
  });
  assert(r.ok);
  assert(r.cortado);
  assertEquals(r.saida.split("\n").length, 41);
});

Deno.test("authorized_keys restringe a redes privadas e sem shell", () => {
  const l = linhaAuthorizedKeys("ssh-ed25519 AAAA vigia@servidor");
  assert(l.startsWith('restrict,from="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1" ssh-ed25519'));
});

Deno.test("telemetria lê /proc de verdade (fallback sem /host/proc)", async () => {
  const t = await lerTelemetria();
  assert(t.cpu.nucleos >= 1);
  assert(t.memoria.totalMb > 0);
  assert(t.cpu.usoPct >= 0 && t.cpu.usoPct <= 100);
  assert(t.avisos.length >= 1); // sem /host/proc aqui
});

Deno.test("alertas: temperatura, memória, carga com iowait e disco cheio", () => {
  const t = {
    em: "", fontes: { procDoHost: true, sysDoHost: true, redeDoHost: true }, avisos: [],
    cpu: { usoPct: 40, iowaitPct: 45, nucleos: 4, carga: { min1: 8, min5: 6, min15: 4 }, cargaPorNucleo: 2, saturado: true },
    memoria: { totalMb: 1000, usadaMb: 950, disponivelMb: 50, cacheMb: 10, swapTotalMb: 0, swapUsadaMb: 0, usadaPct: 95, swapUsadaPct: 0 },
    discos: [{ nome: "sda", leituraMbs: 1, escritaMbs: 80, iops: 300, utilPct: 99 }],
    volumes: [{ ponto: "/data", totalGb: 100, usadoGb: 95, usadoPct: 95 }],
    rede: [], temperaturas: [{ sensor: "coretemp", rotulo: "Package id 0", celsius: 91 }], tempoLigadoHoras: 1,
  } as Telemetria;
  const chaves = avaliarAlertas(t).map((a) => a.chave).sort();
  assertEquals(chaves, ["host:carga", "host:disco:sda", "host:espaco", "host:memoria", "host:temperatura"]);
  assert(avaliarAlertas(t).find((a) => a.chave === "host:carga")!.corpo.includes("disco"));
});
