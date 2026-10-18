/**
 * Chamada de IA (OpenRouter) que devolve JSON validado por schema.
 * Mesma regra do preenchimento: a IA devolve CAMPOS; quem monta a pesquisa,
 * confere codigos e consulta o banco e o backend.
 */
import { request } from "undici";
import { env } from "../lib/env.js";

export class IaIndisponivel extends Error {}

export async function jsonIA<T = any>(o: {
  sistema: string; usuario: string; schema: Record<string, unknown>; nome: string; max_tokens?: number; temperatura?: number;
}): Promise<{ dados: T; modelo: string; custoUsd: number }> {
  if (!env.OPENROUTER_API_KEY) throw new IaIndisponivel("IA não configurada (OPENROUTER_API_KEY no backend).");
  const chamar = async (modelo: string) => {
    const body: Record<string, unknown> = {
      model: modelo,
      messages: [{ role: "system", content: o.sistema }, { role: "user", content: o.usuario }],
      temperature: o.temperatura ?? 0,
      max_tokens: o.max_tokens ?? 1500,
      response_format: { type: "json_schema", json_schema: { name: o.nome, strict: true, schema: o.schema } },
      usage: { include: true },
    };
    if (env.RACIOCINIO_DESLIGADO) body.reasoning = { enabled: false };
    const r = await request("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), headersTimeout: 60_000, bodyTimeout: 60_000,
    });
    if (r.statusCode !== 200) throw new Error(`OpenRouter ${r.statusCode}: ${(await r.body.text()).slice(0, 300)}`);
    const d: any = await r.body.json();
    const txt = String(d?.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    if (!txt) throw new Error("resposta vazia");
    return { dados: JSON.parse(txt) as T, modelo, custoUsd: d.usage?.cost ?? 0 };
  };
  try { return await chamar(env.MODELO_IA); }
  catch (e) {
    if (String(e).includes("OpenRouter 401")) throw new IaIndisponivel("Chave do OpenRouter inválida ou vencida.");
    return await chamar(env.MODELO_IA_FALLBACK);
  }
}
