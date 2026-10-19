// SSH do Vigia até o próprio servidor — SOMENTE LEITURA e LISTA FECHADA.
// Nada de shell livre: cada comando tem nome, argumentos fixos e parâmetros
// validados por regex. A chave é gerada pelo Vigia em /data/ssh (nunca passa
// pelo chat nem pelo env); o administrador só cola a chave PÚBLICA no
// authorized_keys do servidor. Toda execução vai para a auditoria.

const DIR_PADRAO = `${Deno.env.get("VIGIA_DATA_DIR") ?? "/data"}/ssh`;
const LIMITE_SAIDA = 64 * 1024;
const TIMEOUT_MS = 25_000;

export interface ConfigSsh {
  host: string | null;
  porta: number;
  usuario: string;
  dir: string;
}

export function configSsh(): ConfigSsh {
  return {
    host: (Deno.env.get("SSH_HOST") ?? "").trim() || null,
    porta: Number(Deno.env.get("SSH_PORT") ?? 22) || 22,
    usuario: (Deno.env.get("SSH_USER") ?? "vigia").trim() || "vigia",
    dir: Deno.env.get("VIGIA_SSH_DIR") ?? DIR_PADRAO,
  };
}

// ------------------------------------------------------------ catálogo
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DISCO = /^\/dev\/(sd[a-z]{1,2}|vd[a-z]{1,2}|nvme\d{1,2}n\d{1,2}|xvd[a-z]{1,2}|hd[a-z])$/;
const linhas = (v: unknown, padrao: number, max: number) => {
  const n = Math.trunc(Number(v ?? padrao));
  return String(Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : padrao);
};

export interface ComandoSsh {
  descricao: string;
  /** Saída pode conter dados de terceiros (logs): marcada como não confiável. */
  naoConfiavel?: boolean;
  /** Precisa de sudo (o usuário não-root precisa de NOPASSWD para o binário). */
  sudo?: boolean;
  parametros?: Record<string, string>;
  argv(p: Record<string, unknown>): string[];
  /** Corta a saída (ex.: top N processos). */
  maxLinhas?: number;
}

export const COMANDOS: Record<string, ComandoSsh> = {
  uptime: { descricao: "Tempo ligado e carga", argv: () => ["uptime"] },
  memoria: { descricao: "Memória e swap (free -m)", argv: () => ["free", "-m"] },
  espaco: {
    descricao: "Espaço em disco por sistema de arquivos (df)",
    argv: () => ["df", "-hT", "-x", "tmpfs", "-x", "devtmpfs", "-x", "overlay", "-x", "squashfs"],
  },
  discos: {
    descricao: "Discos e partições (lsblk)",
    argv: () => ["lsblk", "-o", "NAME,SIZE,TYPE,MOUNTPOINT,MODEL,ROTA,TRAN"],
  },
  processos: {
    descricao: "Processos que mais usam CPU (top 40)",
    argv: () => ["ps", "-eo", "pid,user,pcpu,pmem,rss,etime,comm", "--sort=-pcpu"],
    maxLinhas: 41,
  },
  processos_memoria: {
    descricao: "Processos que mais usam memória (top 40)",
    argv: () => ["ps", "-eo", "pid,user,pcpu,pmem,rss,etime,comm", "--sort=-rss"],
    maxLinhas: 41,
  },
  containers: {
    descricao: "Containers Docker em execução",
    argv: () => ["docker", "ps", "--format", "{{.Names}}\t{{.Status}}\t{{.Image}}"],
  },
  containers_uso: {
    descricao: "CPU, memória, rede e disco por container (docker stats)",
    argv: () => [
      "docker", "stats", "--no-stream", "--format",
      "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}",
    ],
  },
  container_logs: {
    descricao: "Últimas linhas de log de um container",
    naoConfiavel: true,
    parametros: { container: "nome do container (docker ps)", linhas: "1 a 500 (padrão 100)" },
    argv: (p) => {
      const c = String(p.container ?? "");
      if (!CONTAINER.test(c)) throw new ErroSsh("container inválido");
      return ["docker", "logs", "--tail", linhas(p.linhas, 100, 500), "--timestamps", c];
    },
  },
  docker_espaco: { descricao: "Espaço usado pelo Docker (imagens, volumes, cache)", argv: () => ["docker", "system", "df"] },
  journal: {
    descricao: "Avisos e erros recentes do sistema (journalctl)",
    naoConfiavel: true,
    sudo: true,
    parametros: { linhas: "1 a 500 (padrão 100)" },
    argv: (p) => ["journalctl", "-p", "warning", "-n", linhas(p.linhas, 100, 500), "--no-pager", "-o", "short-iso"],
  },
  kernel: {
    descricao: "Erros e avisos do kernel (dmesg) — disco, memória, temperatura",
    naoConfiavel: true,
    sudo: true,
    argv: () => ["dmesg", "--level=err,warn", "-T"],
    maxLinhas: 300,
  },
  servicos_falhos: { descricao: "Serviços do systemd com falha", argv: () => ["systemctl", "--failed", "--no-legend", "--no-pager"] },
  portas: { descricao: "Portas abertas escutando (ss)", sudo: true, argv: () => ["ss", "-tulnp"] },
  conexoes: {
    descricao: "Conexões de saída estabelecidas (para achar exfiltração)",
    sudo: true,
    argv: () => ["ss", "-tnp", "state", "established"],
    maxLinhas: 400,
  },
  rede: { descricao: "Interfaces e endereços (ip -br addr)", argv: () => ["ip", "-br", "addr"] },
  logins: { descricao: "Últimos logins no servidor", naoConfiavel: true, argv: () => ["last", "-n", "30", "-a"] },
  smart: {
    descricao: "SMART completo de um disco (smartctl)",
    sudo: true,
    parametros: { disco: "ex.: /dev/sda ou /dev/nvme0n1" },
    argv: (p) => {
      const d = String(p.disco ?? "");
      if (!DISCO.test(d)) throw new ErroSsh("disco inválido (use /dev/sdX ou /dev/nvmeXnY)");
      return ["smartctl", "-iHAj", d];
    },
  },
  sensores: { descricao: "Sensores de temperatura e ventoinhas (lm-sensors)", argv: () => ["sensors"] },
  atualizacoes: {
    descricao: "Pacotes com atualização pendente (apt)",
    argv: () => ["apt", "list", "--upgradable"],
    maxLinhas: 300,
  },
};

export class ErroSsh extends Error {
  constructor(m: string) {
    super(m);
    this.name = "ErroSsh";
  }
}

/** Aspas simples de shell: o servidor recebe a linha via `sh -c`. */
export function aspas(a: string): string {
  return `'${a.replaceAll("'", `'\\''`)}'`;
}

/** Monta a linha remota a partir do catálogo (único caminho até o ssh). */
export function linhaRemota(nome: string, p: Record<string, unknown>, usuario: string): {
  linha: string;
  cmd: ComandoSsh;
} {
  const cmd = Object.hasOwn(COMANDOS, nome) ? COMANDOS[nome] : undefined;
  if (!cmd) throw new ErroSsh(`comando fora da lista: ${nome}`);
  const permitidos = new Set(Object.keys(cmd.parametros ?? {}));
  for (const k of Object.keys(p)) {
    if (!permitidos.has(k)) throw new ErroSsh(`parâmetro não aceito: ${k}`);
  }
  const argv = cmd.argv(p);
  if (cmd.sudo && usuario !== "root") argv.unshift("sudo", "-n");
  // LC_ALL=C: saída estável (datas/números) para o parsing.
  return { linha: ["env", "LC_ALL=C", ...argv].map(aspas).join(" "), cmd };
}

// ------------------------------------------------------------ chave
async function existe(p: string) {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function rodar(cmd: string, args: string[], timeoutMs = TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const o = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      signal: ac.signal,
    }).output();
    return {
      code: o.code,
      stdout: new TextDecoder().decode(o.stdout),
      stderr: new TextDecoder().decode(o.stderr),
      tempoEsgotado: false,
    };
  } catch (e) {
    const esgotado = ac.signal.aborted;
    return {
      code: esgotado ? 124 : 127,
      stdout: "",
      stderr: esgotado ? "tempo esgotado" : String((e as Error).message),
      tempoEsgotado: esgotado,
    };
  } finally {
    clearTimeout(t);
  }
}

/** Gera (uma vez) o par ed25519 do Vigia e devolve a chave pública. */
export async function garantirChave(c: ConfigSsh = configSsh()): Promise<string> {
  const priv = `${c.dir}/id_ed25519`;
  if (!(await existe(priv))) {
    await Deno.mkdir(c.dir, { recursive: true, mode: 0o700 });
    const r = await rodar("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "vigia@servidor", "-f", priv]);
    if (r.code !== 0) throw new ErroSsh(`ssh-keygen falhou: ${r.stderr.slice(-200)}`);
  }
  return (await Deno.readTextFile(`${priv}.pub`)).trim();
}

/** Linha pronta para o authorized_keys: sem shell interativo, túnel ou encaminhamento,
 * e aceita só a partir das redes privadas (o container do Vigia). */
export function linhaAuthorizedKeys(pub: string): string {
  return `restrict,from="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1" ${pub}`;
}

export async function infoChave(c: ConfigSsh = configSsh()) {
  const pub = await garantirChave(c);
  return {
    configurado: !!c.host,
    host: c.host,
    porta: c.porta,
    usuario: c.usuario,
    chavePublica: pub,
    authorizedKeys: linhaAuthorizedKeys(pub),
    instrucoes: [
      "No servidor, como root: adduser --disabled-password --gecos '' vigia",
      "mkdir -p /home/vigia/.ssh && chmod 700 /home/vigia/.ssh",
      "Cole a linha de authorizedKeys em /home/vigia/.ssh/authorized_keys (chmod 600, dono vigia)",
      "Para containers: usermod -aG docker vigia",
      "Para SMART, portas, journal e dmesg sem senha: echo 'vigia ALL=(root) NOPASSWD: /usr/sbin/smartctl, /usr/bin/journalctl, /usr/bin/dmesg, /usr/bin/ss' > /etc/sudoers.d/vigia && chmod 440 /etc/sudoers.d/vigia",
      "No EasyPanel → vigia → Environment: SSH_HOST=<IP do servidor na rede local, ex.: 192.168.0.118>, SSH_USER=vigia (SSH_PORT se não for 22) e Deploy",
    ],
  };
}

// ------------------------------------------------------------ execução
export interface ResultadoSsh {
  comando: string;
  ok: boolean;
  codigo: number;
  saida: string;
  erro: string | null;
  cortado: boolean;
  ms: number;
  naoConfiavel: boolean;
}

export type Executor = (cmd: string, args: string[], timeoutMs?: number) => Promise<{
  code: number;
  stdout: string;
  stderr: string;
  tempoEsgotado: boolean;
}>;

export async function executarSsh(
  nome: string,
  params: Record<string, unknown> = {},
  opts: { config?: ConfigSsh; exec?: Executor } = {},
): Promise<ResultadoSsh> {
  const c = opts.config ?? configSsh();
  if (!c.host) {
    throw new ErroSsh(
      "SSH não configurado: defina SSH_HOST (e SSH_USER) no app do Vigia no EasyPanel. Veja servidor_chave_ssh para o passo a passo.",
    );
  }
  const { linha, cmd } = linhaRemota(nome, params, c.usuario);
  if (!opts.exec) await garantirChave(c);
  const exec = opts.exec ?? rodar;
  const t0 = Date.now();
  const r = await exec("ssh", [
    "-i", `${c.dir}/id_ed25519`,
    "-p", String(c.porta),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${c.dir}/known_hosts`,
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=5",
    "-T",
    `${c.usuario}@${c.host}`,
    "--",
    linha,
  ]);
  let saida = r.stdout;
  let cortado = false;
  if (cmd.maxLinhas) {
    const ls = saida.split("\n");
    if (ls.length > cmd.maxLinhas) {
      saida = ls.slice(0, cmd.maxLinhas).join("\n");
      cortado = true;
    }
  }
  if (saida.length > LIMITE_SAIDA) {
    saida = saida.slice(-LIMITE_SAIDA);
    cortado = true;
  }
  let erro: string | null = null;
  if (r.code !== 0) {
    const e = r.stderr.trim();
    erro = r.tempoEsgotado
      ? "tempo esgotado (25 s)"
      : /Permission denied \(publickey/.test(e)
      ? "chave recusada: cole a chave pública do Vigia no authorized_keys do usuário (veja servidor_chave_ssh)"
      : /sudo: a password is required|sudo: a terminal is required/.test(e)
      ? "o comando precisa de sudo sem senha para este binário (veja servidor_chave_ssh)"
      : /Could not resolve|Connection refused|No route|timed out/i.test(e)
      ? `não conectou em ${c.host}:${c.porta} (${e.slice(-160)})`
      : e.slice(-400) || `código ${r.code}`;
  }
  return {
    comando: nome,
    ok: r.code === 0,
    codigo: r.code,
    saida,
    erro,
    cortado,
    ms: Date.now() - t0,
    naoConfiavel: !!cmd.naoConfiavel,
  };
}

export function catalogo() {
  return Object.entries(COMANDOS).map(([nome, c]) => ({
    nome,
    descricao: c.descricao,
    parametros: c.parametros ?? {},
    precisaSudo: !!c.sudo,
  }));
}
