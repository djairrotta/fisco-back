import webpushLib from "web-push";
import type { Config } from "../config.ts";
import type { sql as defaultSql } from "../db/client.ts";

type Sql = typeof defaultSql;

export type TipoEvento =
  | "bloqueio_auto"
  | "sugestao"
  | "anomalia"
  | "estrangeiro_agregado"
  | "modelo_degradado"
  | "coletor_parado"
  | "bloqueio_expirado"
  | "desfeito"
  | "email_recebido"
  | "email_enviado"
  | "auditoria_achado"
  | "app_status"
  | "app_reinicios"
  | "easypanel_falha"
  | "revisao_ia"
  | "revisao_codigo"
  | "supabase_achado"
  | "conector_pedido"
  | "servidor";

export interface Notificacao {
  titulo: string;
  corpo: string;
  url: string;
  acoes?: { acao: string; titulo: string }[];
  chaveAgregacao?: string;
}

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface NotificadorDeps {
  sql: Sql;
  config: Config;
  agora: () => Date;
  /** Envia um push; rejeita com {statusCode} em erro HTTP. */
  webpush: (
    sub: PushSub,
    payload: string,
    opts: { TTL: number },
  ) => Promise<unknown>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Timeout por envio de push (padrão 10 s). */
  timeoutPushMs?: number;
}

export interface ResultadoNotificar {
  push: { ok: number; falhas: number };
  whatsapp: boolean;
  agregado: boolean;
}

const TTL_PUSH = 3600;
const TIMEOUT_WA_MS = 15_000;
const TIMEOUT_PUSH_MS = 10_000;

function comTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`push sem resposta em ${ms} ms`)), ms);
  });
  p.catch(() => {});
  return Promise.race([p, limite]).finally(() => clearTimeout(t));
}
/** Janela mínima (min) entre envios por chave, para tipos agregados. */
const JANELA_MIN: Partial<Record<TipoEvento, number>> = {
  estrangeiro_agregado: 60,
  anomalia: 30,
  // Apps do EasyPanel: no máximo 1 aviso de queda/volta por app a cada 10 min.
  app_status: 10,
  app_reinicios: 30,
  easypanel_falha: 60,
  // Servidor (temperatura, memória, carga, disco): 1 aviso por problema a cada 60 min.
  servidor: 60,
};

let vapidKey = "";
/** Implementação real usando npm:web-push; setVapidDetails uma única vez. */
export function depsPadrao(
  sql: Sql,
  config: Config,
): NotificadorDeps {
  return {
    sql,
    config,
    agora: () => new Date(),
    webpush: (sub, payload, opts) => {
      const k =
        `${config.vapidSubject}|${config.vapidPublic}|${config.vapidPrivate}`;
      if (vapidKey !== k) {
        webpushLib.setVapidDetails(
          config.vapidSubject,
          config.vapidPublic,
          config.vapidPrivate,
        );
        vapidKey = k;
      }
      return webpushLib.sendNotification(sub, payload, {
        ...opts,
        timeout: TIMEOUT_PUSH_MS,
      });
    },
    fetch: (url, init) => fetch(url, init),
  };
}

/** Check-and-set atômico: true se esta chamada ganhou o direito de enviar. */
async function reservarJanela(
  deps: NotificadorDeps,
  tipo: TipoEvento,
  chave: string,
  minutos: number,
): Promise<boolean> {
  const agora = deps.agora();
  const limite = new Date(agora.getTime() - minutos * 60_000);
  const k = `notif_ultimo:${tipo}:${chave}`;
  const rows = await deps.sql`
    INSERT INTO vigia.config_geral (chave, valor)
    VALUES (${k}, to_jsonb(${agora.toISOString()}::text))
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
    WHERE (vigia.config_geral.valor #>> '{}')::timestamptz <= ${limite.toISOString()}::timestamptz
    RETURNING chave`;
  return rows.length > 0;
}

async function enviarWhatsapp(
  deps: NotificadorDeps,
  n: Notificacao,
): Promise<boolean> {
  const { openwaUrl, openwaApiKey, adminPhone } = deps.config;
  const digitos = (adminPhone ?? "").replace(/\D/g, "");
  if (!openwaUrl || !digitos) return false;
  try {
    const r = await deps.fetch(`${openwaUrl.replace(/\/+$/, "")}/sendText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        api_key: openwaApiKey ?? "",
      },
      body: JSON.stringify({
        args: {
          to: `${digitos}@c.us`,
          content: `*${n.titulo}*\n${n.corpo}\n${n.url}`,
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_WA_MS),
    });
    if (!r.ok) {
      console.error(`[notify] open-wa respondeu ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[notify] falha no open-wa:", e);
    return false;
  }
}

export async function notificar(
  tipo: TipoEvento,
  n: Notificacao,
  deps: NotificadorDeps,
): Promise<ResultadoNotificar> {
  const res: ResultadoNotificar = {
    push: { ok: 0, falhas: 0 },
    whatsapp: false,
    agregado: false,
  };
  try {
    const [cfg] = await deps.sql`
      SELECT push, whatsapp FROM vigia.config_notificacao WHERE tipo = ${tipo}`;
    const pushOn: boolean = cfg?.push ?? true;
    const waOn: boolean = cfg?.whatsapp ?? false;
    if (!pushOn && !waOn) return res;

    const janela = JANELA_MIN[tipo];
    if (janela !== undefined) {
      const ok = await reservarJanela(
        deps,
        tipo,
        n.chaveAgregacao ?? "_",
        janela,
      );
      if (!ok) return { ...res, agregado: true };
    }

    let precisaWa = waOn;
    if (pushOn) {
      const subs = await deps.sql`
        SELECT id, endpoint, chaves FROM vigia.push_inscricoes ORDER BY id`;
      const payload = JSON.stringify({
        titulo: n.titulo,
        corpo: n.corpo,
        url: n.url,
        acoes: n.acoes ?? [],
        tipo,
        ts: deps.agora().getTime(),
      });
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
          res.push.ok++;
        } catch (e) {
          res.push.falhas++;
          const code = (e as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) {
            try {
              await deps
                .sql`DELETE FROM vigia.push_inscricoes WHERE id = ${s.id}`;
            } catch (e2) {
              console.error("[notify] falha ao remover inscrição:", e2);
            }
          } else {
            console.error("[notify] falha no push:", code ?? e);
          }
        }
      }));
      if (subs.length === 0 || res.push.ok === 0) precisaWa = true;
    }
    if (precisaWa) res.whatsapp = await enviarWhatsapp(deps, n);
  } catch (e) {
    console.error("[notify] erro ao notificar:", e);
  }
  return res;
}
