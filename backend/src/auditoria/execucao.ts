// Auditoria diária: hosts (sugeridos pelo tráfego, confirmados pelo Djair),
// execução, dedupe/resolução dos achados, push agregado e agenda (06:00 em
// São Paulo).
import type { Sql } from "../db/client.ts";
import { auditar as registrarAuditoria } from "../monitor/executor.ts";
import type { Notificacao, TipoEvento } from "../notify/notifier.ts";
import { ErroApi } from "../api/servicos.ts";
import type { Achado, ResultadoHost, Severidade } from "./verificacoes.ts";

export type EstadoHost = "sugerido" | "confirmado" | "removido";

export type OrigemHost = "trafego" | "easypanel" | "manual";

export interface HostAuditoria {
  host: string;
  estado: EstadoHost;
  zona: string | null;
  acessos: number | null;
  /** producao (padrão) ou teste/staging — libera testes ofensivos gated. */
  ambiente: "producao" | "teste";
  /** trafego (sugerido), easypanel (confirmado sozinho) ou manual. */
  origem: OrigemHost;
}

const RANK: Record<Severidade, number> = { baixa: 1, media: 2, alta: 3 };
export const relevante = (s: Severidade) => RANK[s] >= RANK.media;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

// ------------------------------------------------------------------ hosts

const ROTULO = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Hostname normalizado (minúsculas, sem ponto final) ou null se inválido. */
export function normalizarHost(bruto: string): string | null {
  const h = bruto.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return null;
  const partes = h.split(".");
  if (partes.length < 2 || !partes.every((p) => ROTULO.test(p))) return null;
  if (/^\d+$/.test(partes[partes.length - 1])) return null; // IP
  return h;
}

export async function zonaDoHost(
  sql: Sql,
  host: string,
): Promise<{ id: number; nome: string } | null> {
  const [z] = await sql`
    SELECT id, nome FROM vigia.zonas
    WHERE ativa AND (${host} = lower(nome)
      OR right(${host}, length(nome) + 1) = '.' || lower(nome))
    ORDER BY length(nome) DESC LIMIT 1`;
  return z ? { id: Number(z.id), nome: String(z.nome) } : null;
}

const JANELA_SEMENTE_DIAS = 7;
const MAX_SUGESTOES = 20;

/**
 * Sugere os hosts mais acessados (7 dias) das zonas ativas. Não mexe no
 * estado de hosts já conhecidos (confirmados ou removidos). Devolve quantos
 * entraram como sugestão nova.
 */
export async function semearHosts(sql: Sql, agora: Date): Promise<number> {
  const desde = new Date(agora.getTime() - JANELA_SEMENTE_DIAS * 86_400_000);
  const top = await sql`
    SELECT lower(e.host) host, z.id zona_id, sum(e.contagem)::bigint n
    FROM vigia.eventos e JOIN vigia.zonas z ON z.id = e.zona_id AND z.ativa
    WHERE e.ts > ${desde} AND e.host IS NOT NULL
      AND (lower(e.host) = lower(z.nome)
        OR right(lower(e.host), length(z.nome) + 1) = '.' || lower(z.nome))
    GROUP BY 1, 2 ORDER BY n DESC, 1 LIMIT ${MAX_SUGESTOES}`;
  let novos = 0;
  for (const r of top) {
    const host = normalizarHost(String(r.host));
    if (!host) continue;
    const [x] = await sql`
      INSERT INTO vigia.auditoria_hosts (host, zona_id, estado, acessos)
      VALUES (${host}, ${r.zona_id}, 'sugerido', ${r.n})
      ON CONFLICT (host) DO UPDATE SET acessos = EXCLUDED.acessos
      RETURNING (xmax = 0) AS inserido`;
    if (x?.inserido) novos++;
  }
  return novos;
}

/**
 * Sugere hosts vindos de outra fonte (domínios dos apps do EasyPanel): só os
 * que caem nas zonas ativas; não mexe em hosts já conhecidos (inclusive não
 * reabre 'removido'). Devolve quantos entraram.
 *
 * `confirmar: true` entra já 'confirmado' (o Vigia varre sozinho) e marca a
 * origem — usado para os apps do EasyPanel, que são comprovadamente do Djair.
 * Por padrão entra 'sugerido' com origem 'trafego'.
 */
export async function sugerirHosts(
  sql: Sql,
  brutos: string[],
  opts: { confirmar?: boolean; origem?: OrigemHost } = {},
): Promise<number> {
  const estado = opts.confirmar ? "confirmado" : "sugerido";
  const origem: OrigemHost = opts.origem ?? "trafego";
  let novos = 0;
  for (const b of new Set(brutos)) {
    const host = normalizarHost(b);
    if (!host) continue;
    const z = await zonaDoHost(sql, host);
    if (!z) continue;
    const r = await sql`
      INSERT INTO vigia.auditoria_hosts (host, zona_id, estado, origem)
      VALUES (${host}, ${z.id}, ${estado}, ${origem})
      ON CONFLICT (host) DO NOTHING RETURNING host`;
    novos += r.length;
  }
  return novos;
}

export async function listarHosts(
  sql: Sql,
  incluirRemovidos = false,
): Promise<HostAuditoria[]> {
  const rows = await sql`
    SELECT h.host, h.estado, h.acessos, h.ambiente, h.origem, z.nome zona
    FROM vigia.auditoria_hosts h LEFT JOIN vigia.zonas z ON z.id = h.zona_id
    WHERE ${incluirRemovidos} OR h.estado <> 'removido'
    ORDER BY h.acessos DESC NULLS LAST, h.host`;
  return rows.map((r) => ({
    host: String(r.host),
    estado: r.estado as EstadoHost,
    zona: (r.zona as string | null) ?? null,
    acessos: r.acessos === null ? null : Number(r.acessos),
    ambiente: (r.ambiente as "producao" | "teste" | null) ?? "producao",
    origem: (r.origem as OrigemHost | null) ?? "trafego",
  }));
}

/** Adiciona (ou confirma uma sugestão de) host a auditar; só dentro das zonas. */
export async function adicionarHost(
  sql: Sql,
  bruto: string,
  ator: string,
): Promise<HostAuditoria> {
  const host = normalizarHost(bruto);
  if (!host) {
    throw new ErroApi(400, {
      erro: "Host inválido: use só o nome, ex.: app.exemplo.com.br",
    });
  }
  const z = await zonaDoHost(sql, host);
  if (!z) {
    throw new ErroApi(400, {
      erro: "Host fora das zonas Cloudflare monitoradas pelo Vigia",
    });
  }
  const [r] = await sql`
    INSERT INTO vigia.auditoria_hosts (host, zona_id, estado, origem)
    VALUES (${host}, ${z.id}, 'confirmado', 'manual')
    ON CONFLICT (host) DO UPDATE SET estado = 'confirmado',
      zona_id = EXCLUDED.zona_id, atualizado = now()
    RETURNING ambiente, origem`;
  await registrarAuditoria(sql, ator, "auditoria_host_adicionar", host, {
    zona: z.nome,
  });
  return {
    host,
    estado: "confirmado",
    zona: z.nome,
    acessos: null,
    ambiente: (r?.ambiente as "producao" | "teste" | null) ?? "producao",
    origem: (r?.origem as OrigemHost | null) ?? "manual",
  };
}

/** Tira um host (ou recusa a sugestão); a sugestão não volta sozinha. */
export async function removerHost(
  sql: Sql,
  bruto: string,
  ator: string,
): Promise<{ ok: true; host: string }> {
  const host = normalizarHost(bruto);
  const r = host
    ? await sql`
      UPDATE vigia.auditoria_hosts SET estado = 'removido', atualizado = now()
      WHERE host = ${host} AND estado <> 'removido' RETURNING host`
    : [];
  if (!r.length) throw new ErroApi(404, { erro: "Host não está na lista" });
  await registrarAuditoria(sql, ator, "auditoria_host_remover", host, {});
  return { ok: true, host: host! };
}

// ------------------------------------------------------------- achados

export interface AchadoNovo extends Achado {
  host: string;
}

/**
 * Grava os resultados: um registro por host+verificação. Achado reaparecido
 * depois de resolvido é reaberto (novo de novo); severidade que sobe para
 * média/alta também conta como novo. O que foi avaliado e não apareceu é
 * resolvido.
 */
export async function persistirResultados(
  sql: Sql,
  resultados: ResultadoHost[],
  agora: Date,
): Promise<{ novos: AchadoNovo[]; resolvidos: number }> {
  const novos: AchadoNovo[] = [];
  let resolvidos = 0;
  await sql.begin(async (tx) => {
    for (const r of resultados) {
      for (const a of r.achados) {
        const [atual] = await tx`
          SELECT id, severidade, resolvido_em FROM vigia.auditoria_achados
          WHERE host = ${r.host} AND verificacao = ${a.verificacao}
          FOR UPDATE`;
        const ev = a.evidencia ?? null;
        if (!atual) {
          await tx`INSERT INTO vigia.auditoria_achados
            (host, verificacao, severidade, titulo, recomendacao_ptbr,
             evidencia, first_seen, last_seen)
            VALUES (${r.host}, ${a.verificacao}, ${a.severidade}, ${a.titulo},
              ${a.recomendacao}, ${ev}, ${agora}, ${agora})`;
          novos.push({ ...a, host: r.host });
          continue;
        }
        const reaberto = atual.resolvido_em !== null;
        const subiu = RANK[a.severidade] >
            RANK[atual.severidade as Severidade] && relevante(a.severidade);
        await tx`UPDATE vigia.auditoria_achados SET
            severidade = ${a.severidade}, titulo = ${a.titulo},
            recomendacao_ptbr = ${a.recomendacao}, evidencia = ${ev},
            last_seen = ${agora}, resolvido_em = NULL,
            first_seen = CASE WHEN ${reaberto} THEN ${agora}::timestamptz
              ELSE first_seen END
          WHERE id = ${atual.id}`;
        if (reaberto || subiu) novos.push({ ...a, host: r.host });
      }
      const vistas = r.achados.map((a) => a.verificacao);
      if (r.avaliadas.length) {
        const x = await tx`UPDATE vigia.auditoria_achados
          SET resolvido_em = ${agora}
          WHERE host = ${r.host} AND resolvido_em IS NULL
            AND verificacao = ANY(${r.avaliadas})
            AND NOT (verificacao = ANY(${vistas}))
          RETURNING id`;
        resolvidos += x.length;
      }
    }
  });
  return { novos, resolvidos };
}

export interface ResumoExecucao {
  hosts: number;
  /** Achados novos de severidade média/alta (os que geram push). */
  novos: number;
  resolvidos: number;
  falhas: number;
  /** Hosts em que a borda do Cloudflare barrou a auditoria. */
  bloqueados: string[];
}

export interface UltimaExecucao extends ResumoExecucao {
  inicio: string;
  fim: string;
}

export async function listarAchados(sql: Sql) {
  const rows = await sql`
    SELECT a.* FROM vigia.auditoria_achados a
    WHERE a.resolvido_em IS NULL AND (
      EXISTS (SELECT 1 FROM vigia.auditoria_hosts h
        WHERE h.host = a.host AND h.estado = 'confirmado')
      -- Apps do EasyPanel ("projeto/serviço"): higiene do env.
      OR EXISTS (SELECT 1 FROM vigia.apps p
        WHERE p.projeto || '/' || p.servico = a.host))
    ORDER BY a.host,
      CASE a.severidade WHEN 'alta' THEN 0 WHEN 'media' THEN 1 ELSE 2 END,
      a.verificacao`;
  const grupos = new Map<string, ReturnType<typeof linha>[]>();
  for (const r of rows) {
    const h = String(r.host);
    if (!grupos.has(h)) grupos.set(h, []);
    grupos.get(h)!.push(linha(r));
  }
  const [u] = await sql`SELECT valor FROM vigia.config_geral
    WHERE chave = 'auditoria_ultima'`;
  const pior = (xs: { severidade: Severidade }[]) =>
    Math.max(...xs.map((x) => RANK[x.severidade]));
  return {
    ultimaExecucao: (u?.valor as UltimaExecucao | undefined) ?? null,
    grupos: [...grupos.entries()]
      .map(([host, achados]) => ({ host, achados }))
      .sort((a, b) =>
        pior(b.achados) - pior(a.achados) || a.host.localeCompare(b.host)
      ),
  };
}

function linha(r: Record<string, unknown>) {
  return {
    id: Number(r.id),
    verificacao: String(r.verificacao),
    severidade: r.severidade as Severidade,
    titulo: String(r.titulo),
    recomendacao: String(r.recomendacao_ptbr),
    evidencia: (r.evidencia as string | null) ?? null,
    firstSeen: iso(r.first_seen),
    lastSeen: iso(r.last_seen),
  };
}

// ------------------------------------------------------------- execução

export interface ExecucaoDeps {
  sql: Sql;
  agora: () => Date;
  /** Audita um host (real: auditarHost com o cliente limitado). */
  auditar(host: string): Promise<ResultadoHost>;
  notificar(tipo: TipoEvento, n: Notificacao): Promise<unknown>;
  /** Antes de auditar: redescobre o IP do servidor (protegido). */
  antes?: () => Promise<unknown>;
  /** Hosts auditados em paralelo (cada host segue limitado a 1 req/s). */
  concorrencia?: number;
}

export async function executarAuditoria(
  d: ExecucaoDeps,
): Promise<ResumoExecucao> {
  const inicio = d.agora();
  try {
    await d.antes?.();
  } catch (e) {
    console.error("auditoria: falha ao descobrir o IP do servidor:", e);
  }
  try {
    await semearHosts(d.sql, inicio);
  } catch (e) {
    console.error("auditoria: falha ao sugerir hosts:", e);
  }
  const hosts = (await listarHosts(d.sql))
    .filter((h) => h.estado === "confirmado").map((h) => h.host);
  const resultados: ResultadoHost[] = [];
  let falhas = 0;
  const bloqueados: string[] = [];
  const fila = [...hosts];
  const trabalhador = async () => {
    for (let h = fila.shift(); h !== undefined; h = fila.shift()) {
      try {
        const r = await d.auditar(h);
        if (r.bloqueadoNaBorda) {
          falhas++;
          bloqueados.push(h);
        }
        resultados.push(r);
      } catch (e) {
        falhas++;
        console.error(`auditoria: ${h} falhou:`, (e as Error)?.message ?? e);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(d.concorrencia ?? 4, hosts.length)) },
      trabalhador,
    ),
  );
  const fim = d.agora();
  const { novos, resolvidos } = await persistirResultados(
    d.sql,
    resultados,
    fim,
  );
  const avisar = novos.filter((n) => relevante(n.severidade));
  const resumo: ResumoExecucao = {
    hosts: hosts.length,
    novos: avisar.length,
    resolvidos,
    falhas,
    bloqueados: bloqueados.sort(),
  };
  await d.sql`INSERT INTO vigia.config_geral (chave, valor)
    VALUES ('auditoria_ultima', ${
    d.sql.json({
      ...resumo,
      inicio: inicio.toISOString(),
      fim: fim.toISOString(),
    })
  })
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
  if (avisar.length) {
    try {
      await d.notificar("auditoria_achado", pushAgregado(avisar));
    } catch (e) {
      console.error("auditoria: falha no push:", e);
    }
  }
  return resumo;
}

export function pushAgregado(novos: AchadoNovo[]): Notificacao {
  const altas = novos.filter((n) => n.severidade === "alta").length;
  const linhas = novos
    .sort((a, b) => RANK[b.severidade] - RANK[a.severidade])
    .slice(0, 5)
    .map((n) => `${n.host}: ${n.titulo}`);
  if (novos.length > 5) linhas.push(`e mais ${novos.length - 5}`);
  return {
    titulo: `Auditoria: ${novos.length} achado(s) novo(s)` +
      (altas ? ` (${altas} alto(s))` : ""),
    corpo: linhas.join("\n"),
    url: "/auditoria",
  };
}

// ------------------------------------------------------------- agenda

const FUSO = "America/Sao_Paulo";
const HORA_AUDITORIA_MIN = 6 * 60;

/** Dia (AAAA-MM-DD) e minutos desde 00:00 em São Paulo. */
export function diaHoraSaoPaulo(d: Date): { dia: string; minutos: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: FUSO,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return {
    dia: `${p.year}-${p.month}-${p.day}`,
    minutos: Number(p.hour) * 60 + Number(p.minute),
  };
}

export interface JobAuditoriaDeps {
  sql: Sql;
  agora: () => Date;
  rodar(): Promise<unknown>;
}

/**
 * Chamado a cada poucos minutos: roda uma vez por dia, a partir das 06:00 de
 * São Paulo (se o processo estava parado às 06:00, roda assim que voltar).
 */
export async function jobAuditoria(d: JobAuditoriaDeps): Promise<boolean> {
  const { dia, minutos } = diaHoraSaoPaulo(d.agora());
  if (minutos < HORA_AUDITORIA_MIN) return false;
  const r = await d.sql`
    INSERT INTO vigia.config_geral (chave, valor)
    VALUES ('auditoria_dia', to_jsonb(${dia}::text))
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
    WHERE (vigia.config_geral.valor #>> '{}') < ${dia}
    RETURNING chave`;
  if (!r.length) return false;
  await d.rodar();
  return true;
}

// ------------------------------------------------------------- executor

export interface ExecutorAuditoriaDeps {
  sql: Sql;
  agora: () => Date;
  executar(): Promise<ResumoExecucao>;
  /** Intervalo mínimo entre "rodar agora" (padrão 2 min). */
  intervaloManualMin?: number;
}

export type EstadoDisparo = "iniciada" | "ja_rodando" | "aguarde";

/** Uma execução por vez (agendada ou manual); "rodar agora" em segundo plano. */
export function criarExecutorAuditoria(d: ExecutorAuditoriaDeps) {
  let atual: Promise<ResumoExecucao> | null = null;
  const rodar = async (): Promise<ResumoExecucao | null> => {
    if (atual) return null;
    atual = d.executar();
    try {
      return await atual;
    } finally {
      atual = null;
    }
  };
  return {
    rodar,
    rodando: () => atual !== null,
    async disparar(): Promise<{ estado: EstadoDisparo }> {
      if (atual) return { estado: "ja_rodando" };
      const agora = d.agora();
      const limite = new Date(
        agora.getTime() - (d.intervaloManualMin ?? 2) * 60_000,
      );
      const ok = await d.sql`
        INSERT INTO vigia.config_geral (chave, valor)
        VALUES ('auditoria_manual', to_jsonb(${agora.toISOString()}::text))
        ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor
        WHERE (vigia.config_geral.valor #>> '{}')::timestamptz <= ${limite.toISOString()}::timestamptz
        RETURNING chave`;
      if (!ok.length) return { estado: "aguarde" };
      if (atual) return { estado: "ja_rodando" };
      rodar().catch((e) => console.error("auditoria: execução falhou:", e));
      return { estado: "iniciada" };
    },
  };
}
