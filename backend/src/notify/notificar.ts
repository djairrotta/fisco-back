// Push por tipo e caixa, respeitando correio.config_notificacao (linha da
// caixa sobrepõe a linha global, caixa_id NULL) e limitando `falha` a 1 a
// cada 30 min por caixa. Usado pelo envio (Task 4) e pelo vigia (Task 5).
// Nunca lança.
import type { Sql } from "../db/client.ts";
import type { PayloadPush, ResultadoPush } from "./push.ts";

export type TipoNotificacao = "recebido" | "enviado" | "falha";

export const INTERVALO_FALHA_MS = 30 * 60_000;

/** Janela mínima entre pushes do mesmo tipo e caixa (só os limitados). */
export const INTERVALOS: Partial<Record<TipoNotificacao, number>> = {
  falha: INTERVALO_FALHA_MS,
};

/** Estado do limite em memória (uma réplica). */
export interface Limitador {
  /**
   * true e reserva a janela se `chave` está livre; false se ainda na janela.
   * A reserva evita dois envios simultâneos; `devolver` a desfaz.
   */
  permitir(chave: string, agoraMs: number, intervaloMs: number): boolean;
  /** Desfaz a última reserva (o push não chegou a nenhum aparelho). */
  devolver(chave: string): void;
}

export function criarLimitador(): Limitador {
  const ultimo = new Map<string, number>();
  const anterior = new Map<string, number | undefined>();
  return {
    permitir(chave, agoraMs, intervaloMs) {
      const u = ultimo.get(chave);
      if (u !== undefined && agoraMs - u < intervaloMs) return false;
      anterior.set(chave, u);
      ultimo.set(chave, agoraMs);
      return true;
    },
    devolver(chave) {
      if (!anterior.has(chave)) return;
      const u = anterior.get(chave);
      anterior.delete(chave);
      if (u === undefined) ultimo.delete(chave);
      else ultimo.set(chave, u);
    },
  };
}

/** Compartilhado por padrão entre envio e vigia. */
export const limitadorPadrao: Limitador = criarLimitador();

export interface NotificarDeps {
  sql: Sql;
  agora: () => Date;
  /** Envia a todas as inscrições (enviarPush com depsPadrao em produção). */
  enviar: (p: PayloadPush) => Promise<ResultadoPush>;
  /** Padrão: limitadorPadrao. */
  limitador?: Limitador;
}

export type ResultadoNotificar =
  | "enviado"
  | "desativado"
  | "limitado"
  /** nenhuma inscrição recebeu (ou não há inscrições) */
  | "nao_entregue"
  | "erro";

/** Configuração efetiva: linha da caixa, senão a global; sem linha = ativo. */
export async function notificacaoAtiva(
  sql: Sql,
  tipo: TipoNotificacao,
  caixaId: number | null,
): Promise<boolean> {
  const r = await sql<{ ativo: boolean }[]>`
    SELECT ativo FROM correio.config_notificacao
    WHERE tipo = ${tipo} AND (caixa_id IS NULL OR caixa_id = ${caixaId})
    ORDER BY caixa_id NULLS LAST LIMIT 1`;
  return r[0]?.ativo ?? true;
}

export async function notificar(
  tipo: TipoNotificacao,
  caixaId: number,
  payload: Omit<PayloadPush, "tipo">,
  deps: NotificarDeps,
  opc: { limitar?: boolean } = {},
): Promise<ResultadoNotificar> {
  // a janela só fica ocupada se o push chegou a pelo menos um aparelho
  let reserva: (() => void) | null = null;
  try {
    if (!await notificacaoAtiva(deps.sql, tipo, caixaId)) return "desativado";
    const intervalo = INTERVALOS[tipo];
    if (intervalo && opc.limitar !== false) {
      const lim = deps.limitador ?? limitadorPadrao;
      const chave = `${tipo}:${caixaId}`;
      if (!lim.permitir(chave, deps.agora().getTime(), intervalo)) {
        return "limitado";
      }
      reserva = () => lim.devolver(chave);
    }
    const r = await deps.enviar({ tipo, ...payload });
    if (r.ok > 0) return "enviado";
    reserva?.();
    return "nao_entregue";
  } catch (e) {
    reserva?.();
    console.error(
      "[notificar] falha:",
      (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
    );
    return "erro";
  }
}

/** Pushes disparados sem esperar (fire-and-forget): envio e vigia de caixa. */
const pendentes = new Set<Promise<unknown>>();

/** Roda `p` em segundo plano; erros são engolidos (notificar já registra). */
export function disparar(p: Promise<unknown>): void {
  const q = p.catch(() => {}).finally(() => pendentes.delete(q));
  pendentes.add(q);
}

/** Para testes e desligamento: espera os pushes em voo. */
export async function aguardarNotificacoes(): Promise<void> {
  while (pendentes.size) await Promise.all([...pendentes]);
}
