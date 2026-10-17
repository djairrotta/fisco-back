/**
 * Pecas comuns das rotas autenticadas.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

export interface Sessao { sub: string; tenant: string; papel: string }

/** Tenant e usuario do token. As rotas so chegam aqui depois do authenticate. */
export function sessao(req: FastifyRequest): Sessao {
  return (req as any).user as Sessao;
}

/**
 * CNPJ normalizado. Desde julho/2026 a Receita emite CNPJ ALFANUMERICO:
 * os 12 primeiros caracteres aceitam A-Z. Tirar "tudo que nao e digito"
 * apagaria as letras; aqui so sai pontuacao.
 */
export function limparCnpj(v: string | undefined | null): string {
  return (v || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}
export const cnpjValido = (c: string) => /^[0-9A-Z]{12}[0-9]{2}$/.test(c);
export const raizValida = (r: string) => /^[0-9A-Z]{8}$/.test(r);

export function numero(v: unknown, padrao: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function lista(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

export const naoEncontrado = (reply: FastifyReply, o = "registro") =>
  reply.code(404).send({ erro: `${o} não encontrado` });

/**
 * Cache em memoria com validade. As agregacoes do painel leem milhoes de
 * linhas e a base muda uma vez por trimestre: recalcular a cada clique
 * seria jogar CPU do banco fora.
 */
export function memo<T>(ms: number) {
  const m = new Map<string, { em: number; v: Promise<T> }>();
  return (chave: string, f: () => Promise<T>): Promise<T> => {
    const agora = Date.now();
    const x = m.get(chave);
    if (x && agora - x.em < ms) return x.v;
    const v = f().catch((e) => { m.delete(chave); throw e; });
    m.set(chave, { em: agora, v });
    if (m.size > 500) m.delete(m.keys().next().value as string);
    return v;
  };
}
