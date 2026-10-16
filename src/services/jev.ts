/**
 * Classificacao pelo Jev (TypeSafe) — codigo deterministico, sem LLM.
 *
 * Por que nao modelo de linguagem aqui: esta e a operacao de MAIOR VOLUME
 * do produto (centenas de publicacoes por assinante/mes). Casar nome de
 * parte e extrair numero de processo e trabalho de regra, nao de
 * inferencia: codigo acerta mais, custa zero por chamada e nao alucina.
 */
import { request } from "undici";
import { env } from "../lib/env.js";

export interface ClassificacaoPublicacao {
  classe: string;         // INTIMACAO | DESPACHO | SENTENCA | PENHORA | ...
  prazoDias: number | null;
  numeroCnj: string | null;
  urgente: boolean;
}

const RX_CNJ = /\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/;

/** Fallback local: roda mesmo se o Jev estiver fora. */
export function classificarLocal(texto: string): ClassificacaoPublicacao {
  const t = (texto || "").toUpperCase();
  const numero = texto?.match(RX_CNJ)?.[0]?.replace(/\D/g, "") ?? null;

  let classe = "OUTROS";
  if (/SENTEN[CÇ]A/.test(t)) classe = "SENTENCA";
  else if (/AC[OÓ]RD[AÃ]O/.test(t)) classe = "ACORDAO";
  else if (/PENHORA|BLOQUEIO|SISBAJUD/.test(t)) classe = "PENHORA";
  else if (/EMBARGOS/.test(t)) classe = "EMBARGOS";
  else if (/DESPACHO/.test(t)) classe = "DESPACHO";
  else if (/INTIMA[CÇ][AÃ]O|INTIME-SE/.test(t)) classe = "INTIMACAO";
  else if (/CITA[CÇ][AÃ]O|CITE-SE/.test(t)) classe = "CITACAO";

  const m = t.match(/PRAZO\s+DE\s+(\d{1,3})\s*\(?[^)]*\)?\s*DIAS/);
  const prazoDias = m ? Number(m[1]) : (classe === "INTIMACAO" ? 15 : null);

  return {
    classe, prazoDias, numeroCnj: numero && numero.length === 20 ? numero : null,
    urgente: /PENHORA|BLOQUEIO|LEIL[AÃ]O|PRAZO\s+DE\s+0?[1-5]\s/.test(t),
  };
}

export async function classificar(texto: string): Promise<ClassificacaoPublicacao> {
  if (!env.JEV_BASE_URL) return classificarLocal(texto);
  try {
    const r = await request(`${env.JEV_BASE_URL}/classificar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dominio: "publicacao_judicial", texto }),
    });
    if (r.statusCode !== 200) return classificarLocal(texto);
    const d: any = await r.body.json();
    return {
      classe: d.classe ?? classificarLocal(texto).classe,
      prazoDias: d.prazo_dias ?? null,
      numeroCnj: d.numero_cnj ?? null,
      urgente: Boolean(d.urgente),
    };
  } catch {
    return classificarLocal(texto);
  }
}

/** Triagem de lead: tambem regra, tambem sem LLM. */
export function classificarLead(e: {
  dividaTotal: number; porte?: number | null; simples?: boolean | null;
  temProcesso: boolean; maturidade: string;
}): { prioridade: "alta" | "media" | "baixa"; motivo: string } {
  if (e.maturidade === "derrotada")
    return { prioridade: "baixa", motivo: "tese derrotada: não prospectar" };
  if (e.dividaTotal >= 1_000_000 && e.temProcesso)
    return { prioridade: "alta", motivo: "dívida alta com execução em curso" };
  if (e.dividaTotal >= 500_000)
    return { prioridade: "alta", motivo: "dívida acima de R$ 500 mil" };
  if (e.simples)
    return { prioridade: "baixa", motivo: "Simples Nacional: teses de PIS/COFINS não se aplicam" };
  return { prioridade: "media", motivo: "perfil compatível com a tese" };
}
