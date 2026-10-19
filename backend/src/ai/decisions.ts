// Cliente da Decisions API do OpenRouter (decisões tipadas, ex.: typesafe/jev-1.13).
import { z } from "zod";
import {
  type Deps,
  type Motivo,
  type Papel,
  registrarFalha,
  registrarSucesso,
  testarModelo,
} from "./openrouter.ts";

/** 1ª: endpoint documentado; 2ª: a variante da referência da API (usada após 404). */
export const URLS_DECISOES = [
  "https://openrouter.ai/api/alpha/decisions",
  "https://openrouter.ai/api/v1/api/alpha/decisions",
] as const;
let urlPreferida = 0;
/** Só para testes: volta a preferir a 1ª URL. */
export function _reiniciarUrlDecisoes() {
  urlPreferida = 0;
}

/** Modelos de decisão tipada da TypeSafe (exceto o roteador, que é de chat). */
export function ehModeloDecisoes(modelo: string): boolean {
  return /^typesafe\/jev-/i.test(modelo) && !/jev-router/i.test(modelo);
}

export type Pergunta =
  | {
    type: "choice";
    instructions: string;
    criteria: Record<string, string>;
  }
  | {
    type: "noul";
    instructions: string;
    criteria: { true: string; false: string };
  }
  | { type: "score"; instructions: string; criteria: string[] };

export interface PedidoDecisao {
  model: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, Pergunta>;
}

const Prob = z.number().min(0).max(1);
const RespostaChoice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: Prob.optional(),
  probabilities: z.record(Prob).optional(),
});
const RespostaNoul = z.object({ type: z.literal("noul"), noul: Prob });
const RespostaScore = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: Prob.optional(),
  probabilities: z.record(Prob).optional(),
  legend: z.unknown().optional(),
});
export const Resposta = z.discriminatedUnion("type", [
  RespostaChoice,
  RespostaNoul,
  RespostaScore,
]);
export type Resposta = z.infer<typeof Resposta>;
export type RespostaEscolha = z.infer<typeof RespostaChoice>;

const CorpoDecisao = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  answers: z.record(Resposta),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cost: z.number().optional(),
  }).passthrough().optional(),
});
export type CorpoDecisao = z.infer<typeof CorpoDecisao>;

export type ResultadoDecisao =
  | { ok: true; dados: CorpoDecisao; latenciaMs: number; modelo: string }
  | { ok: false; motivo: Motivo; detalhe: string; modelo: string };

/** Certeza de uma escolha: probabilities[choice]; senão confidence; senão null. */
export function certeza(r: Resposta): number | null {
  if (r.type === "noul") return r.noul;
  if (r.type === "choice") {
    const p = r.probabilities?.[r.choice];
    if (typeof p === "number") return p;
  }
  return typeof r.confidence === "number" ? r.confidence : null;
}

/** Lê modelo e timeout configurados para o papel. */
export async function configPapel(
  deps: Pick<Deps, "sql">,
  papel: Papel,
): Promise<{ modelo: string; timeoutMs: number }> {
  const [c] = await deps.sql`
    SELECT modelo, timeout_ms FROM vigia.config_ia WHERE papel = ${papel}`;
  if (!c) throw new Error(`papel de IA desconhecido: ${papel}`);
  return { modelo: String(c.modelo), timeoutMs: Number(c.timeout_ms) };
}

/**
 * Uma chamada à Decisions API. Valida a resposta (zod e presença/tipo de cada
 * pergunta), grava o diagnóstico do papel e degrada como os modelos de chat.
 */
export async function decidir(
  deps: Deps,
  pedido: PedidoDecisao,
  timeoutMs: number,
  papel: Papel = "jev",
): Promise<ResultadoDecisao> {
  const modelo = pedido.model;
  const falha = async (
    motivo: Motivo,
    detalhe: string,
  ): Promise<ResultadoDecisao> => {
    const d = detalhe.replace(/\s+/g, " ").trim().slice(0, 200);
    await registrarFalha(
      deps.sql,
      papel,
      modelo,
      deps.agora(),
      deps.aoDegradar,
      motivo,
      d,
    );
    return { ok: false, motivo, detalhe: d, modelo };
  };

  const t0 = performance.now();
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expirou = new Promise<"timeout">((res) => {
    timer = setTimeout(() => {
      ctrl.abort();
      res("timeout");
    }, timeoutMs);
  });

  const postar = (url: string) =>
    deps.fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${deps.cfg.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vigia.judinfo.com.br",
        "X-Title": "Vigia",
      },
      body: JSON.stringify(pedido),
      signal: ctrl.signal,
    });

  type Bruto = { corpo: unknown } | { http: string } | { semJson: true };
  let corpo: unknown;
  try {
    const chamada = (async (): Promise<Bruto> => {
      let i = urlPreferida;
      let resp = await postar(URLS_DECISOES[i]);
      if (resp.status === 404) {
        // Rota alternativa da referência da API: tenta uma vez e memoriza.
        await resp.body?.cancel();
        i = 1 - i;
        resp = await postar(URLS_DECISOES[i]);
      }
      if (!resp.ok) {
        await resp.body?.cancel();
        return { http: `http ${resp.status}` };
      }
      urlPreferida = i;
      try {
        const c = await resp.json();
        const erro = (c as { error?: { code?: unknown } })?.error;
        if (erro) {
          return {
            http: `http ${
              typeof erro.code === "number" ? erro.code : resp.status
            }`,
          };
        }
        return { corpo: c };
      } catch {
        return { semJson: true };
      }
    })();
    chamada.catch(() => {});
    const r = await Promise.race([chamada, expirou]);
    if (r === "timeout") return await falha("timeout", "timeout");
    if ("http" in r) return await falha("http", r.http);
    if ("semJson" in r) return await falha("schema", "sem JSON");
    corpo = r.corpo;
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

  const p = CorpoDecisao.safeParse(corpo);
  if (!p.success) {
    const i = p.error.issues[0];
    return await falha(
      "schema",
      `schema: ${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`,
    );
  }
  for (const [k, q] of Object.entries(pedido.questions)) {
    const a = p.data.answers[k];
    if (!a) {
      return await falha("schema", `schema: answers.${k}: resposta ausente`);
    }
    if (a.type !== q.type) {
      return await falha(
        "schema",
        `schema: answers.${k}: tipo ${a.type}, esperado ${q.type}`,
      );
    }
    if (
      a.type === "choice" && q.type === "choice" &&
      !Object.hasOwn(q.criteria, a.choice)
    ) {
      return await falha(
        "schema",
        `schema: answers.${k}.choice: opção desconhecida`,
      );
    }
  }
  await registrarSucesso(deps.sql, papel, deps.agora());
  return {
    ok: true,
    dados: p.data,
    latenciaMs: Math.round(performance.now() - t0),
    modelo,
  };
}

/** Botão "Testar": para modelo de decisão, uma decisão mínima; senão, o teste de chat. */
export async function testarPapel(
  papel: Papel,
  deps: Deps,
): Promise<
  { ok: boolean; latenciaMs: number; modelo: string; motivo?: string }
> {
  const c = await configPapel(deps, papel);
  if (!ehModeloDecisoes(c.modelo)) return await testarModelo(papel, deps);
  const t0 = performance.now();
  const r = await decidir(
    deps,
    {
      model: c.modelo,
      state: "Verificação de conexão do Vigia.",
      questions: {
        ok: {
          type: "noul",
          instructions:
            "Responda verdadeiro: esta é só uma verificação de conexão.",
          criteria: { true: "conexão funcionando", false: "não se aplica" },
        },
      },
    },
    c.timeoutMs,
    papel,
  );
  return r.ok ? { ok: true, latenciaMs: r.latenciaMs, modelo: r.modelo } : {
    ok: false,
    latenciaMs: Math.round(performance.now() - t0),
    modelo: r.modelo,
    motivo: r.detalhe,
  };
}
