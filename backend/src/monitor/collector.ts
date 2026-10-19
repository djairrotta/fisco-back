import type { CfApi } from "../cloudflare/client.ts";
import {
  FIREWALL_QUERY,
  FIREWALL_QUERY_GEQ,
  HTTP_QUERY,
  HTTP_QUERY_GEQ,
} from "../cloudflare/queries.ts";
import type { Evento } from "./types.ts";
import type { Sql } from "../db/client.ts";

export const LIMITE_PAGINA = 10000;
const ATRASO_FW_MS = 30_000;
const JANELA_INICIAL_MS = 5 * 60_000;
/** Recuperação máxima após parada: o que for mais antigo vira lacuna registrada. */
const MAX_ATRASO_MS = 10 * 60_000;
const BACKOFF_MAX_MIN = 30;
const MINUTO = 60_000;

/** Estado de falha por zona em config_geral["coletor_falhas:<zona>"]. */
type FalhaZona = { n: number; proxima: string | null };
export const chaveFalhaZona = (zonaId: number) => `coletor_falhas:${zonaId}`;

type Dims = {
  clientIP: string;
  clientCountryName: string;
  clientAsn?: string | number;
  clientRequestHTTPHost: string;
  clientRequestPath: string;
  clientRequestHTTPMethodName: string;
  edgeResponseStatus: number;
  userAgent: string;
};
type FwRow = Dims & {
  datetime: string;
  action: string;
  source: string;
  description?: string;
};
type HttpRow = Dims & { datetimeMinute: string };
type HttpGroup = { count: number; dimensions: HttpRow };
type Resp<K extends string, R> = {
  viewer: { zones: Array<Record<K, R[]>> };
};

export interface OpcoesColeta {
  limite?: number;
  /** Janela do http (buckets completos); por padrão, a mesma do firewall. */
  httpDesde?: Date;
  httpAte?: Date;
  /** Chamado quando uma página truncada impede coletar tudo. */
  onTruncado?: (motivo: string) => void;
}

function mapear(
  zonaId: number,
  ts: string,
  d: Dims,
  acaoCf: string,
  fonte: Evento["fonte"],
  contagem: number,
): Evento {
  return {
    zonaId,
    ts: new Date(ts),
    ip: d.clientIP,
    pais: d.clientCountryName ?? "",
    asn: Number(d.clientAsn ?? 0) || 0,
    host: d.clientRequestHTTPHost ?? "",
    caminho: d.clientRequestPath ?? "",
    metodo: d.clientRequestHTTPMethodName ?? "",
    status: Number(d.edgeResponseStatus ?? 0),
    ua: d.userAgent ?? "",
    acaoCf,
    fonte,
    contagem,
  };
}

/** sha-1 hex de zona|ts|ip|host|caminho|metodo|status|ua|fonte. */
export async function chaveDedupe(e: Evento): Promise<string> {
  const s = [
    e.zonaId,
    e.ts.toISOString(),
    e.ip,
    e.host,
    e.caminho,
    e.metodo,
    e.status,
    e.ua,
    e.fonte,
  ].join("|");
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map((b) =>
    b.toString(16).padStart(2, "0")
  )
    .join("");
}

function linhas<K extends string, R>(r: Resp<K, R>, k: K): R[] {
  const z = r?.viewer?.zones?.[0];
  if (!z) throw new Error("zona não encontrada ou sem acesso (zones vazio)");
  return z[k] ?? [];
}

export async function coletarZona(
  api: CfApi,
  zona: { id: number; cfZoneId: string },
  desde: Date,
  ate: Date,
  opts: OpcoesColeta = {},
): Promise<Evento[]> {
  const limite = opts.limite ?? LIMITE_PAGINA;
  const out: Evento[] = [];
  const vistos = new Set<string>();
  const trunc = opts.onTruncado ?? (() => {});

  // Firewall: (desde, ate]
  if (desde.getTime() < ate.getTime()) {
    let cursor = desde.toISOString();
    let primeira = true;
    for (;;) {
      const r = await api.graphql<Resp<"firewallEventsAdaptive", FwRow>>(
        primeira ? FIREWALL_QUERY : FIREWALL_QUERY_GEQ,
        {
          zoneTag: zona.cfZoneId,
          desde: cursor,
          ate: ate.toISOString(),
          limite,
        },
      );
      primeira = false;
      const rows = linhas(r, "firewallEventsAdaptive");
      let novos = 0;
      for (const x of rows) {
        const ev = mapear(
          zona.id,
          x.datetime,
          x,
          x.action ?? "",
          "firewall",
          1,
        );
        if (x.description) ev.regraCf = String(x.description).slice(0, 200);
        const k = await chaveDedupe(ev);
        if (vistos.has(k)) continue;
        vistos.add(k);
        out.push(ev);
        novos++;
      }
      if (rows.length < limite) break;
      if (novos === 0) {
        console.error(`coletor: firewall truncado (zona ${zona.id})`);
        trunc(`firewall zona ${zona.id}`);
        break;
      }
      cursor = rows[rows.length - 1].datetime;
    }
  }

  // HTTP: buckets completos em (httpDesde, httpAte]
  const hd = opts.httpDesde ?? desde;
  const ha = opts.httpAte ?? ate;
  if (hd.getTime() < ha.getTime()) {
    let cursor = hd.toISOString();
    let primeira = true;
    for (;;) {
      const r = await api.graphql<
        Resp<"httpRequestsAdaptiveGroups", HttpGroup>
      >(
        primeira ? HTTP_QUERY : HTTP_QUERY_GEQ,
        {
          zoneTag: zona.cfZoneId,
          desde: cursor,
          ate: ha.toISOString(),
          limite,
        },
      );
      primeira = false;
      const rows = linhas(r, "httpRequestsAdaptiveGroups");
      let novos = 0;
      for (const x of rows) {
        const ev = mapear(
          zona.id,
          x.dimensions.datetimeMinute,
          x.dimensions,
          "allow",
          "http",
          Number(x.count ?? 1),
        );
        const k = await chaveDedupe(ev);
        if (vistos.has(k)) continue;
        vistos.add(k);
        out.push(ev);
        novos++;
      }
      if (rows.length < limite) break;
      // página cheia: um minuto pode ter mais grupos do que o limite
      const primeiro = rows[0].dimensions.datetimeMinute;
      const ultimo = rows[rows.length - 1].dimensions.datetimeMinute;
      if (primeiro === ultimo || novos === 0) {
        console.error(
          `coletor: http truncado (zona ${zona.id}, minuto ${ultimo})`,
        );
        trunc(`http zona ${zona.id}`);
      }
      if (novos === 0) break;
      cursor = ultimo;
    }
  }
  return out;
}

/** Incremento atômico de um contador numérico em config_geral. */
async function incrementar(sql: Sql, chave: string, n = 1): Promise<number> {
  const [r] = await sql<{ valor: number }[]>`
    INSERT INTO vigia.config_geral (chave, valor)
    VALUES (${chave}, to_jsonb(${n}::int))
    ON CONFLICT (chave) DO UPDATE
      SET valor = to_jsonb(COALESCE((vigia.config_geral.valor #>> '{}')::int, 0) + ${n}::int)
    RETURNING valor`;
  return Number(r.valor);
}

async function setConfig(sql: Sql, chave: string, valor: unknown) {
  await sql`INSERT INTO vigia.config_geral (chave, valor)
    VALUES (${chave}, ${sql.json(valor as never)})
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
}

const pisoMinuto = (d: Date) =>
  new Date(Math.floor(d.getTime() / MINUTO) * MINUTO);

async function lerFalhas(sql: Sql): Promise<Map<number, FalhaZona>> {
  const rows = await sql`SELECT chave, valor FROM vigia.config_geral
    WHERE chave LIKE 'coletor_falhas:%'`;
  const m = new Map<number, FalhaZona>();
  for (const r of rows) {
    const id = Number(String(r.chave).slice("coletor_falhas:".length));
    const v = r.valor as Partial<FalhaZona> | null;
    m.set(id, { n: Number(v?.n ?? 0) || 0, proxima: v?.proxima ?? null });
  }
  return m;
}

export async function executarColeta(
  deps: { api: CfApi; sql: Sql; agora: () => Date; limite?: number },
): Promise<{ eventos: number; falhas: number }> {
  const { api, sql } = deps;
  const agora = deps.agora();
  const fwAte = new Date(agora.getTime() - ATRASO_FW_MS);
  // bucket M está completo sse M + 60s <= agora
  const httpAte = new Date(pisoMinuto(agora).getTime() - MINUTO);
  const piso = new Date(agora.getTime() - MAX_ATRASO_MS);
  const zonas = await sql<{ id: number; cf_zone_id: string }[]>`
    SELECT id, cf_zone_id FROM vigia.zonas WHERE ativa ORDER BY id`;
  const falhasZona = await lerFalhas(sql);
  let total = 0;
  let truncados = 0;
  let lacunas = 0;

  for (const z of zonas) {
    const fz = falhasZona.get(z.id) ?? { n: 0, proxima: null };
    if (fz.proxima && new Date(fz.proxima).getTime() > agora.getTime()) {
      continue; // em backoff
    }
    try {
      const [c] = await sql<
        { ultimo_ts: Date; ultimo_ts_http: Date | null }[]
      >`SELECT ultimo_ts, ultimo_ts_http FROM vigia.cursores WHERE zona_id = ${z.id}`;
      const inicial = new Date(agora.getTime() - JANELA_INICIAL_MS);
      let fwDesde = c?.ultimo_ts ?? inicial;
      let httpDesde = c
        ? (c.ultimo_ts_http ?? c.ultimo_ts)
        : pisoMinuto(inicial);
      // Nunca tenta recuperar mais que 10 min: registra a lacuna e segue.
      if (fwDesde.getTime() < piso.getTime()) {
        console.error(
          `coletor: zona ${z.id} firewall: lacuna ${fwDesde.toISOString()} → ${piso.toISOString()} não coletada`,
        );
        lacunas++;
        fwDesde = piso;
      }
      const pisoHttp = pisoMinuto(piso);
      if (httpDesde.getTime() < pisoHttp.getTime()) {
        console.error(
          `coletor: zona ${z.id} http: lacuna ${httpDesde.toISOString()} → ${pisoHttp.toISOString()} não coletada`,
        );
        lacunas++;
        httpDesde = pisoHttp;
      }
      const fwOk = fwDesde.getTime() < fwAte.getTime();
      const httpOk = httpDesde.getTime() < httpAte.getTime();
      if (!fwOk && !httpOk) {
        // nada a coletar (ex.: cursor no futuro)
        falhasZona.set(z.id, { n: 0, proxima: null });
        if (fz.n !== 0) {
          await setConfig(sql, chaveFalhaZona(z.id), { n: 0, proxima: null });
        }
        continue;
      }
      const evs = await coletarZona(
        api,
        { id: z.id, cfZoneId: z.cf_zone_id },
        fwDesde,
        fwAte,
        {
          limite: deps.limite,
          httpDesde,
          httpAte,
          onTruncado: () => truncados++,
        },
      );
      const chaves = await Promise.all(evs.map(chaveDedupe));
      const novoFw = fwOk ? fwAte : fwDesde;
      const novoHttp = httpOk ? httpAte : httpDesde;
      const inseridos = await sql.begin(async (tx) => {
        const q = tx as unknown as Sql;
        let n = 0;
        for (let i = 0; i < evs.length; i += 1000) {
          const rows = evs.slice(i, i + 1000).map((e, j) => ({
            zona_id: e.zonaId,
            ts: e.ts,
            ip: e.ip,
            pais: e.pais,
            asn: e.asn,
            host: e.host,
            caminho: e.caminho,
            metodo: e.metodo,
            status: e.status,
            ua: e.ua,
            acao_cf: e.acaoCf,
            regra_cf: e.regraCf ?? null,
            fonte: e.fonte,
            contagem: e.contagem,
            chave_dedupe: chaves[i + j],
          }));
          const ins = await q`INSERT INTO vigia.eventos ${q(rows)}
            ON CONFLICT (zona_id, chave_dedupe) DO NOTHING
            RETURNING id`;
          n += ins.length;
        }
        await q`INSERT INTO vigia.cursores (zona_id, ultimo_ts, ultimo_ts_http)
          VALUES (${z.id}, ${novoFw}, ${novoHttp})
          ON CONFLICT (zona_id) DO UPDATE
            SET ultimo_ts = EXCLUDED.ultimo_ts,
                ultimo_ts_http = EXCLUDED.ultimo_ts_http`;
        return n;
      });
      total += inseridos; // só conta após o commit
      if (fz.n !== 0) {
        await setConfig(sql, chaveFalhaZona(z.id), { n: 0, proxima: null });
      }
      falhasZona.set(z.id, { n: 0, proxima: null });
    } catch (e) {
      const n = fz.n + 1;
      const espera = Math.min(2 ** n, BACKOFF_MAX_MIN) * MINUTO;
      const novo = {
        n,
        proxima: new Date(agora.getTime() + espera).toISOString(),
      };
      falhasZona.set(z.id, novo);
      console.error(
        `coletor: zona ${z.id} falhou (${n}ª seguida; nova tentativa em ${
          espera / MINUTO
        } min):`,
        (e as Error).message,
      );
      try {
        await setConfig(sql, chaveFalhaZona(z.id), novo);
      } catch (e2) {
        console.error(`coletor: gravar falha: ${(e2 as Error).message}`);
      }
    }
  }

  if (truncados > 0) await incrementar(sql, "coletor_truncados", truncados);
  if (lacunas > 0) await incrementar(sql, "coletor_lacunas", lacunas);

  // Falhas seguidas do coletor = pior zona ativa.
  const ativas = new Set(zonas.map((z) => z.id));
  let falhas = 0;
  for (const [id, f] of falhasZona) {
    if (ativas.has(id) && f.n > falhas) falhas = f.n;
  }
  await setConfig(sql, "coletor_falhas", falhas);
  if (falhas === 0) {
    await setConfig(sql, "coletor_ultimo_ok", agora.toISOString());
  }
  return { eventos: total, falhas };
}
