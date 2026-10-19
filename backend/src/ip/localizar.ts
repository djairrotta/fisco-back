// Localização aproximada de IP (país/cidade/provedor) e texto para requisição judicial.
import type { Sql } from "../db/client.ts";
import { ipEmCidr, ipValido } from "../monitor/decision.ts";

/** Dados devolvidos por um provedor de geolocalização de IP. */
export interface DadosIp {
  ip: string;
  pais: string | null;
  pais_codigo: string | null;
  regiao: string | null;
  cidade: string | null;
  lat: number | null;
  lon: number | null;
  provedor: string | null;
  asn: number | null;
  fuso: string | null;
}

/** Interface para trocar o provedor no futuro sem mexer nas rotas. */
export interface ProvedorGeoIp {
  nome: string;
  consultar(ip: string): Promise<DadosIp>;
}

export type LocalIp = DadosIp & {
  fonte: string;
  consultado_em: string;
  mapa_url: string | null;
  cache: boolean;
};

export class ErroLocalizacao extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErroLocalizacao";
  }
}

export const TIMEOUT_PROVEDOR_MS = 8000;
export const CACHE_MS = 7 * 86_400_000;
const DIAS_DOSSIE = 30;
const MAX_LINHAS_DOSSIE = 200;

export const NOTA_DOSSIE =
  "Localização por IP é aproximada (cidade/provedor). A identificação do assinante depende de requisição judicial ao provedor de conexão, que deve guardar os registros por 1 ano (Marco Civil da Internet, Lei 12.965/2014, arts. 13, 15 e 22). Horários em UTC e em horário de Brasília.";

/** Faixas privadas, de loopback, link-local, documentação, multicast e reservadas. */
const NAO_PUBLICAS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
];

/** true só para IP válido, público e roteável (nunca enviar os demais a terceiros). */
export function ipPublico(ip: string): boolean {
  const s = ip.trim();
  if (!ipValido(s)) return false;
  return !NAO_PUBLICAS.some((c) => ipEmCidr(s, c));
}

export function mapaUrl(
  lat: number | null,
  lon: number | null,
): string | null {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=11/${lat}/${lon}`;
}

const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
const numero = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** https://ipwho.is/<ip> — HTTPS, sem chave. */
export function provedorIpwhois(
  f: typeof fetch = fetch,
  timeoutMs = TIMEOUT_PROVEDOR_MS,
): ProvedorGeoIp {
  return {
    nome: "ipwho.is",
    async consultar(ip) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let j: Record<string, unknown>;
      try {
        const r = await f(`https://ipwho.is/${encodeURIComponent(ip)}`, {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (!r.ok) {
          await r.body?.cancel();
          throw new ErroLocalizacao(`ipwho.is: HTTP ${r.status}`);
        }
        j = await r.json();
      } catch (e) {
        if (e instanceof ErroLocalizacao) throw e;
        if (ctrl.signal.aborted) {
          throw new ErroLocalizacao("ipwho.is: tempo esgotado (8 s)");
        }
        throw new ErroLocalizacao(`ipwho.is: ${(e as Error).message}`);
      } finally {
        clearTimeout(t);
      }
      if (j?.success !== true) {
        throw new ErroLocalizacao(
          `ipwho.is: ${texto(j?.message) ?? "consulta recusada"}`,
        );
      }
      const con = (j.connection ?? {}) as Record<string, unknown>;
      const tz = (j.timezone ?? {}) as Record<string, unknown>;
      return {
        ip: texto(j.ip) ?? ip,
        pais: texto(j.country),
        pais_codigo: texto(j.country_code),
        regiao: texto(j.region),
        cidade: texto(j.city),
        lat: numero(j.latitude),
        lon: numero(j.longitude),
        provedor: texto(con.isp) ?? texto(con.org),
        asn: numero(con.asn),
        fuso: texto(tz.id),
      };
    },
  };
}

/** Localiza o IP (cache de 7 dias em vigia.ip_local). IP não público: erro, sem consulta. */
export async function localizarIp(
  sql: Sql,
  provedor: ProvedorGeoIp,
  ipEntrada: string,
  agora: Date,
): Promise<LocalIp> {
  const ip = ipEntrada.trim();
  if (!ipPublico(ip)) {
    throw new ErroLocalizacao("IP privado, reservado ou inválido");
  }
  const [c] = await sql`
    SELECT dados, fonte, consultado_em FROM vigia.ip_local
    WHERE ip = ${ip}::inet
      AND consultado_em > ${new Date(agora.getTime() - CACHE_MS)}`;
  if (c) {
    const d = c.dados as DadosIp;
    return {
      ...d,
      fonte: c.fonte,
      consultado_em: new Date(c.consultado_em).toISOString(),
      mapa_url: mapaUrl(d.lat, d.lon),
      cache: true,
    };
  }
  const d = await provedor.consultar(ip);
  await sql`
    INSERT INTO vigia.ip_local (ip, dados, fonte, consultado_em)
    VALUES (${ip}::inet, ${sql.json(d as never)}, ${provedor.nome}, ${agora})
    ON CONFLICT (ip) DO UPDATE SET dados = EXCLUDED.dados,
      fonte = EXCLUDED.fonte, consultado_em = EXCLUDED.consultado_em`;
  return {
    ...d,
    fonte: provedor.nome,
    consultado_em: agora.toISOString(),
    mapa_url: mapaUrl(d.lat, d.lon),
    cache: false,
  };
}

// ------------------------------------------------------------------ dossiê

const opcoesBrasilia: Intl.DateTimeFormatOptions = {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const BRASILIA = new Intl.DateTimeFormat("pt-BR", opcoesBrasilia);
const BRASILIA_SEG = new Intl.DateTimeFormat("pt-BR", {
  ...opcoesBrasilia,
  second: "2-digit",
});
const utcMin = (d: Date) =>
  `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const utcSeg = (d: Date) =>
  `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
const brasilia = (d: Date, f = BRASILIA) =>
  `${f.format(d).replace(",", "")} Brasília`;
/** Ambos os fusos, para o juízo e o provedor. */
const ambos = (d: Date) => `${utcMin(d)} (${brasilia(d)})`;
/** Dado vindo do atacante: sem quebras de linha/controle, tamanho limitado. */
const limpo = (v: unknown, max = 300) =>
  String(v ?? "—")
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, max)
    .replaceAll("|", "\\|"); // separador das colunas

/** Texto (pt-BR) com os dados do IP para instruir requisição judicial ao provedor. */
export async function montarDossie(
  sql: Sql,
  provedor: ProvedorGeoIp,
  ipEntrada: string,
  agora: Date,
): Promise<string> {
  const ip = ipEntrada.trim();
  const desde = new Date(agora.getTime() - DIAS_DOSSIE * 86_400_000);
  const linhas: string[] = [];
  const add = (...l: string[]) => linhas.push(...l);

  add(
    `DADOS PARA REQUISIÇÃO JUDICIAL — ENDEREÇO IP ${ip}`,
    `Gerado em: ${utcSeg(agora)} (${brasilia(agora, BRASILIA_SEG)})`,
    "Origem dos registros: Vigia, monitor de segurança dos sites do escritório (logs do Cloudflare).",
    "",
    "1. IDENTIFICAÇÃO DO IP",
    `IP: ${ip}`,
  );
  try {
    const l = await localizarIp(sql, provedor, ip, agora);
    add(
      `Provedor (ISP/organização): ${
        limpo(l.provedor ?? "não informado", 200)
      }`,
      `ASN: ${l.asn !== null ? `AS${l.asn}` : "não informado"}`,
      `País: ${limpo(l.pais, 100)}${
        l.pais_codigo ? ` (${limpo(l.pais_codigo, 10)})` : ""
      }`,
      `Região/estado: ${limpo(l.regiao, 100)}`,
      `Cidade: ${limpo(l.cidade, 100)}`,
      `Fuso do IP: ${limpo(l.fuso, 60)}`,
      `Fonte da localização: ${limpo(l.fonte, 60)}, consultada em ${
        ambos(new Date(l.consultado_em))
      }`,
    );
  } catch (e) {
    add(`Localização indisponível: ${limpo((e as Error).message, 200)}`);
  }

  const grupos = await sql`
    SELECT date_trunc('minute', ts) m, host, caminho, metodo, status,
      sum(contagem)::int n
    FROM vigia.eventos
    WHERE ip = ${ip}::inet AND ts >= ${desde} AND ts <= ${agora}
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY m DESC, n DESC
    LIMIT ${MAX_LINHAS_DOSSIE}`;
  const [{ total }] = await sql`
    SELECT count(*)::int total FROM (
      SELECT 1 FROM vigia.eventos
      WHERE ip = ${ip}::inet AND ts >= ${desde} AND ts <= ${agora}
      GROUP BY date_trunc('minute', ts), host, caminho, metodo, status
    ) g`;
  add(
    "",
    `2. ACESSOS REGISTRADOS (últimos ${DIAS_DOSSIE} dias, agrupados por minuto)`,
  );
  if (grupos.length === 0) {
    add("Nenhum acesso registrado no período.");
  } else {
    add(
      total > grupos.length
        ? `Exibidas as ${grupos.length} mais recentes de ${total} linhas.`
        : `${total} linha(s).`,
      "Data/hora UTC | Data/hora Brasília | host | caminho | método | status | quantidade",
    );
    for (const g of [...grupos].reverse()) {
      const m = new Date(g.m);
      add(
        `${utcMin(m)} | ${brasilia(m)} | ${limpo(g.host, 120)} | ${
          limpo(g.caminho)
        } | ${limpo(g.metodo, 10)} | ${g.status ?? "—"} | ${g.n}`,
      );
    }
  }

  const incs = await sql`
    SELECT id, inicio, fim, classe_final FROM vigia.incidentes
    WHERE ${ip}::inet = ANY(ips) ORDER BY id`;
  add("", "3. INCIDENTES DE SEGURANÇA ASSOCIADOS");
  if (incs.length === 0) add("Nenhum incidente registrado para este IP.");
  for (const i of incs) {
    add(
      `#${i.id}: de ${ambos(new Date(i.inicio))} a ${ambos(new Date(i.fim))}${
        i.classe_final ? `; classe: ${i.classe_final}` : ""
      }`,
    );
  }

  const bls = await sql`
    SELECT id, incidente_id, motivo, criado, expira, removido
    FROM vigia.bloqueios WHERE ip = ${ip}::inet ORDER BY id`;
  add("", "4. BLOQUEIOS APLICADOS");
  if (bls.length === 0) add("Nenhum bloqueio aplicado a este IP.");
  for (const b of bls) {
    add(
      `Bloqueio #${b.id}: desde ${ambos(new Date(b.criado))}; ${
        b.expira ? `válido até ${ambos(new Date(b.expira))}` : "sem validade"
      }${b.removido ? `; removido em ${ambos(new Date(b.removido))}` : ""}${
        b.incidente_id ? `; incidente #${b.incidente_id}` : ""
      }; motivo: ${limpo(b.motivo, 200)}`,
    );
  }

  add("", "5. OBSERVAÇÃO", NOTA_DOSSIE);
  return linhas.join("\n") + "\n";
}
