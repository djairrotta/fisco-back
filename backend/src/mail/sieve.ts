// Cliente ManageSieve mínimo (RFC 5804), porta 4190: capacidades, STARTTLS,
// AUTHENTICATE "PLAIN", LISTSCRIPTS, GETSCRIPT, PUTSCRIPT, SETACTIVE,
// DELETESCRIPT e LOGOUT, com literais {n}/{n+}.
//
// TLS como o resto do Correio: MAIL_SECURE=true exige STARTTLS (o ManageSieve
// não tem TLS implícito); MAIL_TLS_VERIFY=false aceita certificado de outro
// nome (poste.io por hostname interno). MAIL_SECURE=false só em testes/dev.
// Nunca registra credenciais nem ecoa o texto bruto do servidor em logs.
import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import type { Config } from "../config.ts";
import type { CaixaLogin, ConfigMail } from "./conexao.ts";
import { FalhaAutenticacao } from "./conexao.ts";

export type ConfigSieve = Pick<
  Config,
  "sieveHost" | "sievePort" | "mailTlsVerify" | "mailSecure"
>;

/** SIEVE_HOST/SIEVE_PORT, ou IMAP_HOST e 4190 quando só há ConfigMail. */
export function configSieve(
  mail: ConfigMail & Partial<ConfigSieve>,
): ConfigSieve {
  return {
    sieveHost: mail.sieveHost ?? mail.imapHost,
    sievePort: mail.sievePort ?? 4190,
    mailTlsVerify: mail.mailTlsVerify,
    mailSecure: mail.mailSecure,
  };
}

/** O servidor respondeu NO a um comando (ex.: script inválido). */
export class RecusaSieve extends Error {
  constructor(
    /** Texto do servidor (pt-BR não garantido; mostre com cuidado). */
    public texto: string,
    public codigo: string | null,
  ) {
    super(texto || "comando recusado pelo servidor Sieve");
    this.name = "RecusaSieve";
  }
}

/** Protocolo inesperado, BYE, ou servidor sem STARTTLS com MAIL_SECURE. */
export class FalhaProtocoloSieve extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FalhaProtocoloSieve";
  }
}

export interface Capacidades {
  implementacao: string | null;
  sasl: string[];
  /** Extensões Sieve (minúsculas): fileinto, vacation, copy, date… */
  extensoes: Set<string>;
  starttls: boolean;
  /** MAXREDIRECTS anunciado; null se o servidor não informa. */
  maxRedirects: number | null;
}

export interface ScriptSieve {
  nome: string;
  ativo: boolean;
}

export interface ClienteSieve {
  readonly capacidades: Capacidades;
  listar(): Promise<ScriptSieve[]>;
  /** null se o script não existe. */
  ler(nome: string): Promise<string | null>;
  gravar(nome: string, conteudo: string): Promise<void>;
  /** "" desativa todos. */
  ativar(nome: string): Promise<void>;
  apagar(nome: string): Promise<void>;
  /** LOGOUT e fecha; nunca lança. */
  sair(): Promise<void>;
}

// ------------------------------------------------------------ leitura

type Token = string | { atomo: string } | Token[];

const ehAtomo = (t: Token | undefined): t is { atomo: string } =>
  !!t && typeof t === "object" && !Array.isArray(t);

const MAX_LINHA = 64 * 1024;
const MAX_LITERAL = 4 * 1024 * 1024;

class Leitor {
  private buf: Buffer = Buffer.alloc(0);
  private acordar: (() => void) | null = null;
  private erro: Error | null = null;
  private fechado = false;
  private sock: net.Socket | null = null;
  private readonly aoDado = (d: Buffer) => {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    this.sinal();
  };
  private readonly aoErro = (e: Error) => {
    this.erro ??= e;
    this.sinal();
  };
  private readonly aoFim = () => {
    this.fechado = true;
    this.sinal();
  };

  private sinal() {
    const a = this.acordar;
    this.acordar = null;
    a?.();
  }

  anexar(s: net.Socket) {
    this.sock = s;
    s.on("data", this.aoDado);
    s.on("error", this.aoErro);
    s.on("end", this.aoFim);
    s.on("close", this.aoFim);
  }

  /** Bytes recebidos e ainda não consumidos. */
  pendentes(): number {
    return this.buf.length;
  }

  /** Descarta o que foi recebido e não consumido. */
  descartar() {
    this.buf = Buffer.alloc(0);
  }

  desanexar() {
    const s = this.sock;
    if (!s) return;
    s.off("data", this.aoDado);
    s.off("error", this.aoErro);
    s.off("end", this.aoFim);
    s.off("close", this.aoFim);
    this.sock = null;
    this.fechado = false;
  }

  private async esperar() {
    if (this.erro) throw this.erro;
    if (this.fechado) {
      throw new FalhaProtocoloSieve("conexão encerrada pelo servidor");
    }
    await new Promise<void>((r) => (this.acordar = r));
    if (this.erro) throw this.erro;
  }

  async linha(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\r\n");
      if (i >= 0) {
        const l = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 2);
        return l;
      }
      if (this.buf.length > MAX_LINHA) {
        throw new FalhaProtocoloSieve("linha longa demais do servidor");
      }
      if (this.fechado && !this.erro) {
        throw new FalhaProtocoloSieve("conexão encerrada pelo servidor");
      }
      await this.esperar();
    }
  }

  async bytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) await this.esperar();
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(b);
  }

  /** Uma linha lógica: tokens, listas (…) e literais {n}/{n+} embutidos. */
  async linhaLogica(): Promise<Token[]> {
    const raiz: Token[] = [];
    const pilha: Token[][] = [raiz];
    for (;;) {
      const l = await this.linha();
      let i = 0;
      let literal: number | null = null;
      while (i < l.length) {
        const ch = l[i];
        if (ch === " ") {
          i++;
        } else if (ch === '"') {
          let s = "";
          i++;
          while (i < l.length && l[i] !== '"') {
            if (l[i] === "\\" && i + 1 < l.length) i++;
            s += l[i++];
          }
          i++;
          pilha.at(-1)!.push(s);
        } else if (ch === "(") {
          const lista: Token[] = [];
          pilha.at(-1)!.push(lista);
          pilha.push(lista);
          i++;
        } else if (ch === ")") {
          if (pilha.length > 1) pilha.pop();
          i++;
        } else {
          const m = /^\{(\d{1,9})\+?\}$/.exec(l.slice(i));
          if (m) {
            literal = Number(m[1]);
            break;
          }
          let j = i;
          while (j < l.length && !" ()".includes(l[j])) j++;
          pilha.at(-1)!.push({ atomo: l.slice(i, j) });
          i = j;
        }
      }
      if (literal === null) return raiz;
      if (literal > MAX_LITERAL) {
        throw new FalhaProtocoloSieve("literal grande demais do servidor");
      }
      pilha.at(-1)!.push((await this.bytes(literal)).toString("utf8"));
    }
  }
}

interface Resposta {
  linhas: Token[][];
  status: "OK" | "NO" | "BYE";
  codigo: string | null;
  texto: string;
}

async function lerResposta(l: Leitor): Promise<Resposta> {
  const linhas: Token[][] = [];
  for (;;) {
    const ts = await l.linhaLogica();
    const p = ts[0];
    if (ehAtomo(p) && /^(OK|NO|BYE)$/i.test(p.atomo)) {
      let codigo: string | null = null;
      let texto = "";
      for (const t of ts.slice(1)) {
        if (Array.isArray(t)) {
          const c = t[0];
          codigo = ehAtomo(c) ? c.atomo.toUpperCase() : null;
        } else if (typeof t === "string") texto = t;
      }
      return {
        linhas,
        status: p.atomo.toUpperCase() as Resposta["status"],
        codigo,
        texto,
      };
    }
    linhas.push(ts);
  }
}

function capacidadesDe(linhas: Token[][]): Capacidades {
  const c: Capacidades = {
    implementacao: null,
    sasl: [],
    extensoes: new Set(),
    starttls: false,
    maxRedirects: null,
  };
  for (const l of linhas) {
    const nome = typeof l[0] === "string" ? l[0].toUpperCase() : "";
    const valor = typeof l[1] === "string" ? l[1] : "";
    if (nome === "IMPLEMENTATION") c.implementacao = valor;
    else if (nome === "SASL") {
      c.sasl = valor.split(/\s+/).filter(Boolean).map((s) => s.toUpperCase());
    } else if (nome === "SIEVE") {
      c.extensoes = new Set(
        valor.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()),
      );
    } else if (nome === "STARTTLS") c.starttls = true;
    else if (nome === "MAXREDIRECTS" && /^\d+$/.test(valor)) {
      c.maxRedirects = Number(valor);
    }
  }
  return c;
}

// ------------------------------------------------------------ escrita

/** String entre aspas do ManageSieve (sem CR/LF/NUL). */
export function aspas(s: string): string {
  if (/[\r\n\0]/.test(s)) {
    throw new FalhaProtocoloSieve("texto com quebra de linha");
  }
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Literal não sincronizante {n+} (n em bytes UTF-8). */
export function literal(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([Buffer.from(`{${b.length}+}\r\n`), b]);
}

const ehIp = (h: string) => net.isIP(h) !== 0;

/**
 * Conecta, lê as capacidades, faz STARTTLS (se MAIL_SECURE) e autentica com
 * PLAIN. Senha recusada → FalhaAutenticacao. Quem chama deve `sair()`.
 */
export async function abrirSieve(
  cfg: ConfigSieve,
  caixa: CaixaLogin,
  senha: string,
  opc: { timeoutMs?: number } = {},
): Promise<ClienteSieve> {
  const timeoutMs = opc.timeoutMs ?? 20_000;
  const leitor = new Leitor();
  let sock: net.Socket = await new Promise<net.Socket>((res, rej) => {
    const s = net.connect({ host: cfg.sieveHost, port: cfg.sievePort });
    const falha = (e: Error) => {
      s.destroy();
      rej(e);
    };
    const esgotou = () =>
      falha(Object.assign(new Error("tempo esgotado"), { code: "ETIMEDOUT" }));
    s.setTimeout(timeoutMs);
    s.once("timeout", esgotou);
    s.once("error", falha);
    s.once("connect", () => {
      s.off("error", falha);
      s.off("timeout", esgotou);
      res(s);
    });
  });
  const tempo = () => {
    sock.destroy(
      Object.assign(new Error("tempo esgotado"), { code: "ETIMEDOUT" }),
    );
  };
  sock.setTimeout(timeoutMs, tempo);
  leitor.anexar(sock);

  const escrever = (b: string | Buffer) =>
    new Promise<void>((res, rej) => sock.write(b, (e) => (e ? rej(e) : res())));
  const comando = async (linha: string | Buffer): Promise<Resposta> => {
    await escrever(
      typeof linha === "string" ? `${linha}\r\n` : linha,
    );
    const r = await lerResposta(leitor);
    if (r.status === "BYE") {
      throw new FalhaProtocoloSieve("servidor encerrou a sessão");
    }
    return r;
  };

  try {
    let saud = await lerResposta(leitor);
    if (saud.status !== "OK") {
      throw new FalhaProtocoloSieve("saudação recusada pelo servidor");
    }
    let caps = capacidadesDe(saud.linhas);

    if (cfg.mailSecure) {
      if (!caps.starttls) {
        throw new FalhaProtocoloSieve("servidor não oferece STARTTLS");
      }
      const r = await comando("STARTTLS");
      if (r.status !== "OK") {
        throw new FalhaProtocoloSieve("STARTTLS recusado");
      }
      // Nada pode vir em texto puro depois do OK do STARTTLS: seria resposta
      // injetada por quem está no meio (classe CVE-2011-0411). Recusa.
      if (leitor.pendentes() > 0) {
        throw new FalhaProtocoloSieve(
          "dados em texto puro após STARTTLS; conexão recusada",
        );
      }
      leitor.desanexar();
      leitor.descartar();
      const cru = sock;
      cru.setTimeout(0);
      cru.off("timeout", tempo);
      sock = await new Promise<net.Socket>((res, rej) => {
        const t = tls.connect({
          socket: cru,
          rejectUnauthorized: cfg.mailTlsVerify,
          ...(ehIp(cfg.sieveHost) ? {} : { servername: cfg.sieveHost }),
        });
        const falha = (e: Error) => {
          t.destroy();
          rej(e);
        };
        const esgotou = () =>
          falha(
            Object.assign(new Error("tempo esgotado"), { code: "ETIMEDOUT" }),
          );
        t.setTimeout(timeoutMs);
        t.once("timeout", esgotou);
        t.once("error", falha);
        t.once("secureConnect", () => {
          t.off("error", falha);
          t.off("timeout", esgotou);
          res(t);
        });
      });
      sock.setTimeout(timeoutMs, tempo);
      leitor.anexar(sock);
      saud = await lerResposta(leitor); // capacidades de novo (RFC 5804 §2.2)
      if (saud.status !== "OK") {
        throw new FalhaProtocoloSieve("resposta inesperada após STARTTLS");
      }
      caps = capacidadesDe(saud.linhas);
    }

    if (caps.sasl.length && !caps.sasl.includes("PLAIN")) {
      throw new FalhaProtocoloSieve("servidor não aceita login PLAIN");
    }
    const cred = Buffer.from(`\0${caixa.endereco}\0${senha}`, "utf8")
      .toString("base64");
    const auth = await comando(`AUTHENTICATE "PLAIN" ${aspas(cred)}`);
    if (auth.status !== "OK") {
      if (auth.codigo === "TRYLATER") {
        throw new FalhaProtocoloSieve("servidor indisponível no momento");
      }
      throw new FalhaAutenticacao();
    }

    const exigirOk = (r: Resposta) => {
      if (r.status !== "OK") throw new RecusaSieve(r.texto, r.codigo);
    };

    const cliente: ClienteSieve = {
      capacidades: caps,
      async listar() {
        const r = await comando("LISTSCRIPTS");
        exigirOk(r);
        return r.linhas
          .filter((l) => typeof l[0] === "string")
          .map((l) => ({
            nome: l[0] as string,
            ativo: ehAtomo(l[1]) && l[1].atomo.toUpperCase() === "ACTIVE",
          }));
      },
      async ler(nome) {
        const r = await comando(`GETSCRIPT ${aspas(nome)}`);
        if (r.status === "NO" && r.codigo === "NONEXISTENT") return null;
        exigirOk(r);
        const s = r.linhas[0]?.[0];
        return typeof s === "string" ? s : "";
      },
      async gravar(nome, conteudo) {
        exigirOk(
          await comando(
            Buffer.concat([
              Buffer.from(`PUTSCRIPT ${aspas(nome)} `),
              literal(conteudo),
              Buffer.from("\r\n"),
            ]),
          ),
        );
      },
      async ativar(nome) {
        exigirOk(await comando(`SETACTIVE ${aspas(nome)}`));
      },
      async apagar(nome) {
        exigirOk(await comando(`DELETESCRIPT ${aspas(nome)}`));
      },
      async sair() {
        let t: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            comando("LOGOUT").catch(() => {}),
            new Promise((r) => (t = setTimeout(r, 2000))),
          ]);
        } finally {
          clearTimeout(t);
          leitor.desanexar();
          sock.on("error", () => {});
          sock.destroy();
        }
      },
    };
    return cliente;
  } catch (e) {
    leitor.desanexar();
    sock.on("error", () => {});
    sock.destroy();
    throw e;
  }
}
