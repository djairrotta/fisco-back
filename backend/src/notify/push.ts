// Envio de Web Push (parte de push do notifier do Vigia, sem WhatsApp nem
// agregação). Best-effort: nunca lança; inscrições mortas (404/410) são removidas.
import webpushLib from "web-push";
import type { Sql } from "../db/client.ts";

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Conteúdo entregue ao service worker do PWA. */
export interface PayloadPush {
  tipo: string;
  titulo: string;
  corpo: string;
  url: string;
  /** Ícone da notificação (ex.: logo da caixa). */
  icone?: string;
  /** Agrupa notificações no aparelho (mesma tag substitui a anterior). */
  tag?: string;
}

export interface PushDeps {
  sql: Sql;
  agora: () => Date;
  /** Envia um push; rejeita com {statusCode} em erro HTTP. */
  webpush: (
    sub: PushSub,
    payload: string,
    opts: { TTL: number },
  ) => Promise<unknown>;
  /** Timeout por envio (padrão 10 s). */
  timeoutPushMs?: number;
}

export interface ResultadoPush {
  ok: number;
  falhas: number;
}

export interface VapidCfg {
  vapidSubject: string;
  vapidPublic: string;
  vapidPrivate: string;
}

const TTL_PUSH = 3600;
const TIMEOUT_PUSH_MS = 10_000;

function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`push sem resposta em ${ms} ms`)), ms);
  });
  p.catch(() => {});
  return Promise.race([p, limite]).finally(() => clearTimeout(t));
}

let vapidKey = "";
/** Implementação real com npm:web-push; setVapidDetails só quando muda. */
export function depsPadrao(sql: Sql, cfg: VapidCfg): PushDeps {
  return {
    sql,
    agora: () => new Date(),
    webpush: (sub, payload, opts) => {
      const k = `${cfg.vapidSubject}|${cfg.vapidPublic}|${cfg.vapidPrivate}`;
      if (vapidKey !== k) {
        webpushLib.setVapidDetails(
          cfg.vapidSubject,
          cfg.vapidPublic,
          cfg.vapidPrivate,
        );
        vapidKey = k;
      }
      return webpushLib.sendNotification(sub, payload, {
        ...opts,
        timeout: TIMEOUT_PUSH_MS,
      });
    },
  };
}

/** Envia o payload a todas as inscrições. */
export async function enviarPush(
  p: PayloadPush,
  deps: PushDeps,
): Promise<ResultadoPush> {
  const res: ResultadoPush = { ok: 0, falhas: 0 };
  try {
    const subs = await deps.sql`
      SELECT id, endpoint, chaves FROM correio.push_inscricoes ORDER BY id`;
    const payload = JSON.stringify({ ...p, ts: deps.agora().getTime() });
    await Promise.all(subs.map(async (s) => {
      try {
        await comTimeout(
          deps.webpush(
            { endpoint: s.endpoint, keys: s.chaves },
            payload,
            { TTL: TTL_PUSH },
          ),
          deps.timeoutPushMs ?? TIMEOUT_PUSH_MS,
        );
        res.ok++;
      } catch (e) {
        res.falhas++;
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) {
          try {
            await deps
              .sql`DELETE FROM correio.push_inscricoes WHERE id = ${s.id}`;
          } catch (e2) {
            console.error("[push] falha ao remover inscrição:", e2);
          }
        } else {
          console.error(
            "[push] falha no envio:",
            code ?? (e as Error)?.message,
          );
        }
      }
    }));
  } catch (e) {
    console.error("[push] erro ao enviar:", (e as Error)?.message ?? e);
  }
  return res;
}
