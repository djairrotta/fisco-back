import { z } from "zod";
import type { Config } from "../config.ts";
import type { Sql } from "../db/client.ts";

export type Papel =
  | "jev"
  | "segunda"
  | "terceira"
  | "investigacao"
  | "revisor";
export type Motivo = "timeout" | "http" | "schema";

export interface Deps {
  fetch: typeof fetch;
  sql: Sql;
  cfg: Config;
  agora: () => Date;
  aoDegradar: (papel: Papel, modelo: string) => Promise<void>;
}

export type Resultado<T> =
  | { ok: true; dados: T; latenciaMs: number; modelo: string }
  | {
    ok: false;
    motivo: Motivo;
    /** Razão curta e precisa: timeout | http <status> | schema: <1º problema> | sem JSON. */
    detalhe: string;
    modelo: string;
  };

export interface OpcoesChamada {
  /** Teto de tokens da resposta (raciocínio incluso em alguns provedores). Padrão 2000. */
  maxTokens?: number;
}

const URL_OR = "https://openrouter.ai/api/v1/chat/completions";
const AVISO_MIN_MS = 30 * 60_000;
const FALHAS_PARA_DEGRADAR = 3;
export const MAX_TOKENS_PADRAO = 2000;
const MAX_DETALHE = 200;

/**
 * Roteadores (ex.: typesafe/jev-router, openrouter/auto) escolhem o modelo a
 * cada pedido; o destino pode não aceitar response_format. Para eles o JSON é
 * pedido só no prompt e extraído do texto (content/reasoning).
 */
export function aceitaResponseFormat(modelo: string): boolean {
  const m = modelo.toLowerCase();
  return !/(^|[/\-])router($|[-:])/.test(m) && m !== "openrouter/auto";
}

/** Textos onde o JSON pode estar: content, depois reasoning e reasoning_details[].text. */
function textosDaResposta(corpo: unknown): string[] {
  const msg = (corpo as {
    choices?: { message?: Record<string, unknown> }[];
  })?.choices?.[0]?.message;
  if (!msg || typeof msg !== "object") return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v);
  };
  const c = msg.content;
  if (Array.isArray(c)) {
    add(
      c.map((p) => (p as { text?: unknown })?.text)
        .filter((t) => typeof t === "string").join(""),
    );
  } else add(c);
  add(msg.reasoning);
  if (Array.isArray(msg.reasoning_details)) {
    for (const d of msg.reasoning_details) add((d as { text?: unknown })?.text);
  }
  return out;
}

const curto = (s: string) =>
  s.replace(/\s+/g, " ").trim().slice(0, MAX_DETALHE);

/** Extrai JSON do texto: cerca ```json, senão o primeiro bloco {...} balanceado. */
export function extrairJson(texto: string): unknown {
  const t = texto.trim();
  const cerca = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidatos = [t];
  if (cerca) candidatos.unshift(cerca[1].trim());
  for (const c of candidatos) {
    try {
      return JSON.parse(c);
    } catch { /* tenta o próximo */ }
    const bloco = primeiroBloco(c);
    if (bloco !== null) {
      try {
        return JSON.parse(bloco);
      } catch { /* segue */ }
    }
  }
  throw new Error("sem JSON");
}

function primeiroBloco(s: string): string | null {
  for (let ini = s.indexOf("{"); ini !== -1; ini = s.indexOf("{", ini + 1)) {
    let prof = 0, str = false, esc = false;
    for (let i = ini; i < s.length; i++) {
      const ch = s[i];
      if (str) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') str = false;
        continue;
      }
      if (ch === '"') str = true;
      else if (ch === "{") prof++;
      else if (ch === "}" && --prof === 0) {
        const cand = s.slice(ini, i + 1);
        try {
          JSON.parse(cand);
          return cand;
        } catch {
          break;
        } // este início não serve; tenta o próximo "{"
      }
    }
  }
  return null;
}

export async function registrarSucesso(sql: Sql, papel: Papel, agora: Date) {
  await sql`
    UPDATE vigia.config_ia
    SET falhas_seguidas = 0, degradado_desde = NULL, ultimo_ok_em = ${agora}
    WHERE papel = ${papel}`;
}

export async function registrarFalha(
  sql: Sql,
  papel: Papel,
  modelo: string,
  agora: Date,
  aoDegradar: Deps["aoDegradar"],
  motivo: Motivo,
  detalhe: string,
) {
  const limite = new Date(agora.getTime() - AVISO_MIN_MS);
  // Timeout degrada (e avisa) na hora; outros erros só após 3 seguidos.
  const limiar = motivo === "timeout" ? 1 : FALHAS_PARA_DEGRADAR;
  const [r] = await sql`
    UPDATE vigia.config_ia c SET
      ultimo_erro_em = ${agora},
      ultimo_erro = ${detalhe},
      falhas_seguidas = c.falhas_seguidas + 1,
      degradado_desde = CASE WHEN c.falhas_seguidas + 1 >= ${limiar}
        THEN COALESCE(c.degradado_desde, ${agora}::timestamptz)
        ELSE c.degradado_desde END,
      ultimo_aviso = CASE WHEN c.falhas_seguidas + 1 >= ${limiar}
        AND (o.ultimo_aviso IS NULL OR o.ultimo_aviso < ${limite}::timestamptz)
        THEN ${agora}::timestamptz ELSE c.ultimo_aviso END
    FROM (
      SELECT papel, ultimo_aviso FROM vigia.config_ia
      WHERE papel = ${papel} FOR UPDATE
    ) o
    WHERE c.papel = o.papel
    RETURNING c.ultimo_aviso IS DISTINCT FROM o.ultimo_aviso AS avisar`;
  if (r?.avisar) {
    try {
      await aoDegradar(papel, modelo);
    } catch { /* aviso é best-effort; nunca derruba o ciclo */ }
  }
}

export async function chamarModelo<T>(
  papel: Papel,
  mensagens: { role: string; content: string }[],
  // Input `unknown`: aceita schemas com preprocess (saída tipada, entrada livre).
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  deps: Deps,
  opcoes: OpcoesChamada = {},
): Promise<Resultado<T>> {
  const { sql, cfg } = deps;
  const [conf] = await sql`
    SELECT modelo, timeout_ms FROM vigia.config_ia WHERE papel = ${papel}`;
  if (!conf) throw new Error(`papel de IA desconhecido: ${papel}`);
  const modelo: string = conf.modelo;
  const timeoutMs: number = conf.timeout_ms;

  const falha = async (
    motivo: Motivo,
    detalhe: string,
  ): Promise<Resultado<T>> => {
    const d = curto(detalhe);
    await registrarFalha(
      sql,
      papel,
      modelo,
      deps.agora(),
      deps.aoDegradar,
      motivo,
      d,
    );
    return { ok: false, motivo, detalhe: d, modelo };
  };

  const corpoPedido: Record<string, unknown> = {
    model: modelo,
    messages: mensagens,
    temperature: 0,
    max_tokens: opcoes.maxTokens ?? MAX_TOKENS_PADRAO,
  };
  if (aceitaResponseFormat(modelo)) {
    corpoPedido.response_format = { type: "json_object" };
  }

  const t0 = performance.now();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expirou = new Promise<"timeout">((res) => {
    timer = setTimeout(() => {
      ctrl.abort();
      res("timeout");
    }, timeoutMs);
  });

  type Bruto = { textos: string[] } | { http: string } | { semJson: true };
  let textos: string[];
  try {
    const chamada = (async (): Promise<Bruto> => {
      const resp = await deps.fetch(URL_OR, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${cfg.openrouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://vigia.judinfo.com.br",
          "X-Title": "Vigia",
        },
        body: JSON.stringify(corpoPedido),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        await resp.body?.cancel();
        return { http: `http ${resp.status}` };
      }
      let corpo: unknown;
      try {
        corpo = await resp.json();
      } catch {
        return { semJson: true };
      }
      const erro = (corpo as { error?: { code?: unknown } })?.error;
      if (erro) {
        const cod = typeof erro.code === "number" ||
            (typeof erro.code === "string" && /^\d{3}$/.test(erro.code))
          ? erro.code
          : resp.status;
        return { http: `http ${cod}` };
      }
      return { textos: textosDaResposta(corpo) };
    })();
    chamada.catch(() => {}); // evita rejeição não tratada se o timeout vencer
    const r = await Promise.race([chamada, expirou]);
    if (r === "timeout") return await falha("timeout", "timeout");
    if ("http" in r) return await falha("http", r.http);
    if ("semJson" in r) return await falha("schema", "sem JSON");
    textos = r.textos;
  } catch (e) {
    if (
      ctrl.signal.aborted ||
      (e instanceof DOMException && e.name === "AbortError")
    ) {
      return await falha("timeout", "timeout");
    }
    return await falha("http", "http erro de rede");
  } finally {
    clearTimeout(timer);
  }

  // 1º texto com JSON que passa no schema; senão, o 1º problema do zod.
  let problema: string | null = null;
  for (const t of textos) {
    let bruto: unknown;
    try {
      bruto = extrairJson(t);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(bruto);
    if (parsed.success) {
      await registrarSucesso(sql, papel, deps.agora());
      return {
        ok: true,
        dados: parsed.data,
        latenciaMs: Math.round(performance.now() - t0),
        modelo,
      };
    }
    if (problema === null) {
      const i = parsed.error.issues[0];
      problema = `schema: ${
        i.path.length ? `${i.path.join(".")}: ` : ""
      }${i.message}`;
    }
  }
  return await falha("schema", problema ?? "sem JSON");
}

/** Teste rápido de um papel (botão "Testar"): pede {"ok":true}. */
export async function testarModelo(
  papel: Papel,
  deps: Deps,
): Promise<
  { ok: boolean; latenciaMs: number; modelo: string; motivo?: string }
> {
  const t0 = performance.now();
  const r = await chamarModelo(
    papel,
    [{
      role: "user",
      content: 'Responda apenas com este JSON, sem texto extra: {"ok":true}',
    }],
    z.object({ ok: z.literal(true) }),
    deps,
  );
  const latenciaMs = r.ok ? r.latenciaMs : Math.round(performance.now() - t0);
  return r.ok
    ? { ok: true, latenciaMs, modelo: r.modelo }
    : { ok: false, latenciaMs, modelo: r.modelo, motivo: r.detalhe };
}
