import { ipsAdminVigentes } from "./ips_admin.ts";
import { ipsServidorVigentes, ROTULO_IP_SERVIDOR } from "./ip_servidor.ts";
import { CfError } from "../cloudflare/client.ts";
import type { CfApi } from "../cloudflare/client.ts";
import type { Config } from "../config.ts";
import type { Sql } from "../db/client.ts";
import { normalizarIp } from "./grouper.ts";
import { CLOUDFLARE_IPS_PADRAO, ipCasa, ipEmCidr } from "./decision.ts";

export interface ExecutorDeps {
  api: CfApi;
  sql: Sql;
  cfg: Pick<Config, "cfAccountId"> & Partial<Pick<Config, "vigiaHost">>;
  agora: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface RegraCf {
  description: string;
  expression: string;
  action: string;
  enabled: boolean;
  /** Só em regras da fase http_ratelimit. */
  ratelimit?: Record<string, unknown>;
  /** Parâmetros da ação (ex.: headers na fase http_response_headers_transform). */
  action_parameters?: Record<string, unknown>;
}

export const FASE_HEADERS = "http_response_headers_transform";

export const FASE_CUSTOM = "http_request_firewall_custom";
export const FASE_RATELIMIT = "http_ratelimit";

export const NOME_LISTA = "vigia_bloqueados";
export const REGRA_BLOQUEIO: RegraCf = {
  description: "Vigia: bloqueados",
  expression: `ip.src in $${NOME_LISTA}`,
  action: "block",
  enabled: true,
};
const MSG_COTA_LISTA =
  "Limite de listas do plano Free atingido — remova a lista existente ou faça upgrade";
const DIA_MS = 86_400_000;
const TENTATIVAS = 3;
const POLL_MAX = 20;
const POLL_MS = 500;

type CfItem = { id: string; ip: string; comment?: string };
type CfRule = RegraCf & { id: string };
type CfRuleset = { id: string; rules?: CfRule[] };

// ---------- util ----------

export async function auditar(
  sql: Sql,
  ator: string,
  acao: string,
  alvo: string | null,
  detalhes: Record<string, unknown>,
): Promise<void> {
  await sql`
    INSERT INTO vigia.auditoria (ator, acao, alvo, detalhes)
    VALUES (${ator}, ${acao}, ${alvo}, ${sql.json(detalhes as never)})`;
}

function transitorio(e: unknown): boolean {
  if (e instanceof CfError) {
    return e.status === 0 || e.status === 429 || e.status >= 500;
  }
  return e instanceof TypeError; // fetch: falha de rede
}

/** Até 3 tentativas com backoff exponencial (só para erros transitórios). */
export async function comRetry<T>(
  deps: ExecutorDeps,
  fn: () => Promise<T>,
): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < TENTATIVAS; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimo = e;
      if (!transitorio(e) || i === TENTATIVAS - 1) break;
      await deps.sleep(500 * 2 ** i);
    }
  }
  throw ultimo;
}

const base = (deps: ExecutorDeps) =>
  `/accounts/${deps.cfg.cfAccountId}/rules/lists`;

async function aguardarOperacao(
  deps: ExecutorDeps,
  operationId: string | undefined,
): Promise<void> {
  if (!operationId) return;
  for (let i = 0; i < POLL_MAX; i++) {
    const op = await comRetry(
      deps,
      () =>
        deps.api.rest<{ status: string; error?: string }>(
          "GET",
          `${base(deps)}/bulk_operations/${operationId}`,
        ),
    );
    if (op?.status === "completed") return;
    if (op?.status === "failed") {
      throw new CfError(200, [`operação em lote falhou: ${op.error ?? "?"}`]);
    }
    await deps.sleep(POLL_MS);
  }
  throw new CfError(0, ["operação em lote não concluiu a tempo"]);
}

// ---------- lista ----------

async function buscarLista(deps: ExecutorDeps): Promise<string | null> {
  const listas = await comRetry(
    deps,
    () => deps.api.rest<{ id: string; name: string }[]>("GET", base(deps)),
  );
  return (listas ?? []).find((l) => l.name === NOME_LISTA)?.id ?? null;
}

async function garantirLista(deps: ExecutorDeps): Promise<string> {
  const achada = await buscarLista(deps);
  if (achada) return achada;
  try {
    const l = await comRetry(
      deps,
      () =>
        deps.api.rest<{ id: string }>("POST", base(deps), {
          name: NOME_LISTA,
          kind: "ip",
          description: "Vigia: IPs bloqueados automaticamente",
        }),
    );
    return l.id;
  } catch (e) {
    if (
      e instanceof CfError &&
      /limit|quota|maximum|exceed|too many/i.test(e.messages.join(" "))
    ) {
      throw new CfError(e.status, [MSG_COTA_LISTA]);
    }
    throw e;
  }
}

const mesmoIp = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

async function acharItem(
  deps: ExecutorDeps,
  listaId: string,
  ip: string,
): Promise<CfItem | null> {
  const itens = await comRetry(deps, () =>
    deps.api.rest<CfItem[]>(
      "GET",
      `${base(deps)}/${listaId}/items?search=${encodeURIComponent(ip)}`,
    ));
  return (itens ?? []).find((i) => mesmoIp(i.ip, ip)) ?? null;
}

// ---------- regra por zona ----------

/** Mesmos valores (ordem de chaves irrelevante) nas chaves de `esperado`. */
function contem(atual: unknown, esperado: unknown): boolean {
  if (esperado === null || typeof esperado !== "object") {
    return atual === esperado;
  }
  if (Array.isArray(esperado)) {
    return Array.isArray(atual) && atual.length === esperado.length &&
      esperado.every((v, i) => contem(atual[i], v));
  }
  if (atual === null || typeof atual !== "object") return false;
  return Object.entries(esperado).every(([k, v]) =>
    contem((atual as Record<string, unknown>)[k], v)
  );
}

/**
 * Garante a regra `regra` (identificada pela descrição) no entrypoint da fase
 * (padrão http_request_firewall_custom) da zona. Nunca faz PUT de um
 * entrypoint existente nem toca em regras de outra descrição.
 */
export async function garantirRegraZona(
  api: CfApi,
  zoneId: string,
  regra: RegraCf,
  fase: string = FASE_CUSTOM,
): Promise<"criada" | "atualizada" | "inalterada"> {
  const path = `/zones/${zoneId}/rulesets/phases/${fase}/entrypoint`;
  let rs: CfRuleset;
  try {
    rs = await api.rest<CfRuleset>("GET", path);
  } catch (e) {
    if (e instanceof CfError && e.status === 404) {
      await api.rest("PUT", path, { rules: [regra] });
      return "criada";
    }
    throw e;
  }
  const mesmas = (rs.rules ?? []).filter((r) =>
    r.description === regra.description
  );
  const existente = mesmas[0];
  // Duplicatas da própria regra do Vigia (ex.: POST repetido após uma
  // resposta perdida) ocupam vagas do plano e impedem outras regras do
  // Vigia: remove as extras. Regras de outra descrição nunca são tocadas.
  if (regra.description.startsWith("Vigia:")) {
    for (const dup of mesmas.slice(1)) {
      await api.rest(
        "DELETE",
        `/zones/${zoneId}/rulesets/${rs.id}/rules/${dup.id}`,
      );
    }
  }
  if (!existente) {
    await api.rest("POST", `/zones/${zoneId}/rulesets/${rs.id}/rules`, regra);
    return "criada";
  }
  if (
    existente.expression === regra.expression &&
    existente.action === regra.action &&
    existente.enabled === regra.enabled &&
    (regra.ratelimit === undefined ||
      contem(existente.ratelimit, regra.ratelimit)) &&
    (regra.action_parameters === undefined ||
      contem(existente.action_parameters, regra.action_parameters))
  ) {
    return "inalterada";
  }
  await api.rest(
    "PATCH",
    `/zones/${zoneId}/rulesets/${rs.id}/rules/${existente.id}`,
    regra,
  );
  return "atualizada";
}

export async function garantirInfra(
  deps: ExecutorDeps,
  zonas: string[],
): Promise<{ listaId: string; zonasComFalha: string[] }> {
  const listaId = await garantirLista(deps);
  const zonasComFalha: string[] = [];
  for (const z of zonas) {
    try {
      const resultado = await comRetry(
        deps,
        () => garantirRegraZona(deps.api, z, REGRA_BLOQUEIO),
      );
      if (resultado !== "inalterada") {
        await auditar(deps.sql, "sistema", "garantir_infra", z, {
          listaId,
          resultado,
        });
      }
    } catch (e) {
      const erro = (e as Error).message;
      console.error(`executor: regra da zona ${z} falhou: ${erro}`);
      zonasComFalha.push(z);
      await auditar(deps.sql, "sistema", "garantir_infra", z, {
        listaId,
        erro,
      });
    }
  }
  return { listaId, zonasComFalha };
}

// ---------- lock por IP ----------

/**
 * Serializa bloquear/remover do mesmo IP com advisory lock de sessão numa
 * conexão reservada; o fluxo inteiro (inclusive chamadas à CF) usa essa conexão.
 */
export async function comLockIp<T>(
  deps: ExecutorDeps,
  ip: string,
  fn: (d: ExecutorDeps) => Promise<T>,
): Promise<T> {
  const chave = `vigia:${ip}`;
  const c = await deps.sql.reserve();
  let pid: number | null = null;
  try {
    // Nunca espera indefinidamente por um lock preso.
    await c`SET lock_timeout = '30s'`;
    const [r] = await c`SELECT pg_backend_pid() AS pid,
      pg_advisory_lock(hashtextextended(${chave}, 0))`;
    pid = Number(r.pid);
    try {
      return await fn({ ...deps, sql: c as unknown as Sql });
    } finally {
      try {
        await c`RESET lock_timeout`;
      } catch { /* conexão será descartada abaixo se o unlock falhar */ }
      try {
        await c`SELECT pg_advisory_unlock(hashtextextended(${chave}, 0))`;
      } catch (e) {
        console.error(`executor: unlock falhou: ${(e as Error).message}`);
        await descartarConexao(deps.sql, pid);
      }
    }
  } finally {
    c.release();
  }
}

/**
 * Encerra a sessão do backend `pid` (por outra conexão do pool), liberando
 * locks de sessão presos; o postgres.js reconecta essa vaga no próximo uso.
 */
export async function descartarConexao(sql: Sql, pid: number | null) {
  if (pid === null) return;
  try {
    await sql`SELECT pg_terminate_backend(${pid})`;
  } catch (e) {
    console.error(`descartar conexão ${pid} falhou: ${(e as Error).message}`);
  }
}

// ---------- IPs protegidos ----------

/** Bloqueio recusado: IP permitido (vigia.permitidos) ou do Cloudflare. */
export class IpProtegido extends Error {
  ip: string;
  motivo: string;
  constructor(ip: string, motivo: string) {
    super(`IP ${ip} protegido: ${motivo}`);
    this.name = "IpProtegido";
    this.ip = ip;
    this.motivo = motivo;
  }
}

async function motivoProtecao(
  deps: ExecutorDeps,
  ip: string,
): Promise<string | null> {
  if (CLOUDFLARE_IPS_PADRAO.some((c) => ipEmCidr(ip, c))) {
    return "faixa de IPs do Cloudflare";
  }
  const per = await deps.sql`
    SELECT ip::text ip FROM vigia.permitidos
    WHERE expira IS NULL OR expira > ${deps.agora()}`;
  const achado = per.find((r) => {
    const e = String(r.ip).replace(/\/(32|128)$/, "");
    return ipCasa(ip, e);
  });
  if (achado) return `permitido (${achado.ip})`;
  const admin = await ipsAdminVigentes(deps.sql, deps.agora());
  const a = admin.find((e) => ipCasa(ip, e));
  if (a) return `IP do administrador (${a})`;
  const srv = await ipsServidorVigentes(deps.sql, deps.agora());
  const s = srv.find((e) => ipCasa(ip, e));
  return s ? `IP do ${ROTULO_IP_SERVIDOR} (${s})` : null;
}

// ---------- bloqueios ----------

/** Garante o IP na lista da CF (acha ou adiciona). `adicionado` indica se foi preciso POST. */
async function garantirItem(
  deps: ExecutorDeps,
  listaId: string,
  ip: string,
  comentario: string,
): Promise<{ item: CfItem | null; adicionado: boolean }> {
  const existente = await acharItem(deps, listaId, ip);
  if (existente) return { item: existente, adicionado: false };
  await comRetry(deps, async () => {
    const res = await deps.api.rest<{ operation_id?: string }>(
      "POST",
      `${base(deps)}/${listaId}/items`,
      [{ ip, comment: comentario }],
    );
    await aguardarOperacao(deps, res?.operation_id);
  });
  let item: CfItem | null = null;
  try {
    item = await acharItem(deps, listaId, ip);
  } catch (e) {
    console.error(
      `executor: não localizou item de ${ip}: ${(e as Error).message}`,
    );
  }
  return { item, adicionado: true };
}

const maisTarde = (a: Date, b: Date) => (a > b ? a : b);

/** Bloqueia o IP por `dias` (aceita fração; 1 = 24 h exatas). */
export async function bloquear(
  deps: ExecutorDeps,
  ipEntrada: string,
  incidenteId: number | null,
  motivo: string,
  ator: string,
  dias = 7,
  _tentativa = 0,
): Promise<{ bloqueioId: number }> {
  const ip = normalizarIp(ipEntrada);
  const protecao = await motivoProtecao(deps, ip);
  if (protecao !== null) {
    try {
      await auditar(deps.sql, ator, "bloquear_recusado", ip, {
        incidenteId,
        motivo,
        protecao,
      });
    } catch (e2) {
      console.error(`executor: auditoria falhou: ${(e2 as Error).message}`);
    }
    throw new IpProtegido(ip, protecao);
  }
  try {
    return await comLockIp(
      deps,
      ip,
      (d) =>
        bloquearInterno(d, ip, incidenteId, motivo, ator, dias, _tentativa),
    );
  } catch (e) {
    try {
      await auditar(deps.sql, ator, "bloquear_falhou", ip, {
        incidenteId,
        motivo,
        dias,
        erro: (e as Error).message,
      });
    } catch (e2) {
      console.error(`executor: auditoria falhou: ${(e2 as Error).message}`);
    }
    throw e;
  }
}

async function bloquearInterno(
  deps: ExecutorDeps,
  ip: string,
  incidenteId: number | null,
  motivo: string,
  ator: string,
  dias: number,
  tentativa: number,
): Promise<{ bloqueioId: number }> {
  const { sql } = deps;
  const agora = deps.agora();
  const novaExpira = new Date(agora.getTime() + Math.round(dias * DIA_MS));
  const comentario = incidenteId === null ? "manual" : `inc:${incidenteId}`;
  // Qualquer linha não removida do IP é a vigente, mesmo vencida: estende-a.
  const [ativo] = await sql`
    SELECT id, expira FROM vigia.bloqueios
    WHERE ip = ${ip}::inet AND removido IS NULL
    ORDER BY id DESC LIMIT 1`;
  const listaId = await garantirLista(deps);
  if (ativo) {
    const { item, adicionado } = await garantirItem(
      deps,
      listaId,
      ip,
      comentario,
    );
    const atual = ativo.expira ? new Date(ativo.expira) : novaExpira;
    const expira = maisTarde(atual, novaExpira);
    await sql`
      UPDATE vigia.bloqueios
      SET expira = ${expira}, cf_item_id = COALESCE(${
      item?.id ?? null
    }, cf_item_id)
      WHERE id = ${ativo.id}`;
    await auditar(sql, ator, "prorrogar", ip, {
      bloqueioId: Number(ativo.id),
      dias,
      incidenteId,
      motivo,
      readicionado: adicionado,
      expira: expira.toISOString(),
    });
    return { bloqueioId: Number(ativo.id) };
  }
  const { item, adicionado } = await garantirItem(
    deps,
    listaId,
    ip,
    comentario,
  );
  let bloqueioId: number;
  try {
    const [row] = await sql`
      INSERT INTO vigia.bloqueios (ip, incidente_id, motivo, criado, expira, cf_item_id)
      VALUES (${ip}::inet, ${incidenteId}, ${motivo}, ${agora}, ${novaExpira}, ${
      item?.id ?? null
    })
      RETURNING id`;
    bloqueioId = Number(row.id);
  } catch (e) {
    if ((e as { code?: string }).code === "23505" && tentativa < 1) {
      // corrida: outro bloqueio do mesmo IP entrou; estende-o (sem apagar o item da CF)
      return bloquearInterno(
        deps,
        ip,
        incidenteId,
        motivo,
        ator,
        dias,
        tentativa + 1,
      );
    }
    if ((e as { code?: string }).code === "23505") throw e; // 2ª corrida: sem limpeza
    await limparOrfao(deps, listaId, ip, item, adicionado, e as Error);
    throw e;
  }
  await auditar(sql, ator, "bloquear", ip, {
    bloqueioId,
    incidenteId,
    motivo,
    dias,
    listaId,
    expira: novaExpira.toISOString(),
  });
  return { bloqueioId };
}

/** Melhor esforço: o INSERT falhou depois do item entrar na CF — remove o item e audita. */
async function limparOrfao(
  deps: ExecutorDeps,
  listaId: string,
  ip: string,
  item: CfItem | null,
  adicionado: boolean,
  causa: Error,
): Promise<void> {
  let removidoDaCf = false;
  if (adicionado) {
    try {
      const it = item ?? await acharItem(deps, listaId, ip);
      if (it) {
        const res = await deps.api.rest<{ operation_id?: string }>(
          "DELETE",
          `${base(deps)}/${listaId}/items`,
          { items: [{ id: it.id }] },
        );
        await aguardarOperacao(deps, res?.operation_id);
        removidoDaCf = true;
      }
    } catch (e) {
      console.error(
        `executor: limpeza de órfão falhou: ${(e as Error).message}`,
      );
    }
  }
  try {
    await auditar(deps.sql, "sistema", "orfao", ip, {
      itemId: item?.id ?? null,
      adicionado,
      removidoDaCf,
      erro: causa.message,
    });
  } catch (e) {
    console.error(
      `executor: auditoria de órfão falhou: ${(e as Error).message}`,
    );
  }
}

/** Soma `dias` (aceita fração: 1 = 24 h exatas) ao vencimento do bloqueio ativo. */
export async function prorrogar(
  deps: ExecutorDeps,
  bloqueioId: number,
  dias: number,
  ator = "sistema",
): Promise<void> {
  const [b] = await deps.sql`
    SELECT host(ip) ip FROM vigia.bloqueios WHERE id = ${bloqueioId}`;
  if (!b) throw new Error(`bloqueio ${bloqueioId} não encontrado`);
  // Mesmo lock de bloquear/remover: não prorroga linha sendo removida.
  await comLockIp(deps, normalizarIp(b.ip), async (d) => {
    const agora = d.agora();
    const r = await d.sql`
      UPDATE vigia.bloqueios
      SET expira = GREATEST(COALESCE(expira, ${agora}), ${agora}::timestamptz)
        + make_interval(secs => ${Math.round(dias * 86_400)}::float8)
      WHERE id = ${bloqueioId} AND removido IS NULL
      RETURNING expira`;
    if (r.length === 0) {
      throw new Error(`bloqueio ${bloqueioId} já removido`);
    }
    await auditar(d.sql, ator, "prorrogar", b.ip, {
      bloqueioId,
      dias,
      expira: new Date(r[0].expira).toISOString(),
    });
  });
}

/**
 * Remove o IP da lista da CF e marca removido; idempotente.
 * Primeiro "reivindica" a linha (UPDATE atômico); só então apaga na CF. Assim um
 * bloquear que estendeu a linha entre a leitura e aqui não perde o item.
 */
async function remover(
  deps: ExecutorDeps,
  bloqueioId: number,
  ator: string,
  acao: "desfazer" | "expirar",
): Promise<{ ok: true; jaRemovido: boolean; pulado: boolean }> {
  const [b] = await deps.sql`
    SELECT host(ip) ip FROM vigia.bloqueios WHERE id = ${bloqueioId}`;
  if (!b) throw new Error(`bloqueio ${bloqueioId} não encontrado`);
  return comLockIp(
    deps,
    normalizarIp(b.ip),
    (d) => removerInterno(d, bloqueioId, ator, acao),
  );
}

async function removerInterno(
  deps: ExecutorDeps,
  bloqueioId: number,
  ator: string,
  acao: "desfazer" | "expirar",
): Promise<{ ok: true; jaRemovido: boolean; pulado: boolean }> {
  const { sql } = deps;
  const agora = deps.agora();
  const [b] = await sql`
    SELECT host(ip) ip FROM vigia.bloqueios WHERE id = ${bloqueioId}`;
  if (!b) throw new Error(`bloqueio ${bloqueioId} não encontrado`);
  const [claim] = acao === "expirar"
    ? await sql`
      UPDATE vigia.bloqueios SET removido = ${agora}
      WHERE id = ${bloqueioId} AND removido IS NULL AND expira <= ${agora}
      RETURNING id`
    : await sql`
      UPDATE vigia.bloqueios SET removido = ${agora}
      WHERE id = ${bloqueioId} AND removido IS NULL
      RETURNING id`;
  if (!claim) {
    if (acao === "expirar") {
      return { ok: true, jaRemovido: false, pulado: true }; // estendido ou já removido
    }
    await auditar(sql, ator, acao, b.ip, {
      bloqueioId,
      jaRemovido: true,
      pulouCf: false,
    });
    return { ok: true, jaRemovido: true, pulado: false };
  }
  let jaRemovido = false;
  let pulouCf = false;
  try {
    const [outro] = await sql`
      SELECT 1 FROM vigia.bloqueios
      WHERE ip = ${b.ip}::inet AND removido IS NULL AND id <> ${bloqueioId}
        AND expira > ${agora}
      LIMIT 1`;
    if (outro) {
      pulouCf = true; // outro bloqueio vigente do mesmo IP depende do item
    } else {
      const listaId = await buscarLista(deps);
      const item = listaId ? await acharItem(deps, listaId, b.ip) : null;
      if (!listaId || !item) {
        jaRemovido = true;
      } else {
        try {
          await comRetry(deps, async () => {
            const res = await deps.api.rest<{ operation_id?: string }>(
              "DELETE",
              `${base(deps)}/${listaId}/items`,
              { items: [{ id: item.id }] },
            );
            await aguardarOperacao(deps, res?.operation_id);
          });
        } catch (e) {
          if (!(e instanceof CfError && e.status === 404)) throw e;
          jaRemovido = true;
        }
      }
    }
  } catch (e) {
    // devolve a linha ao estado ativo para nova tentativa no próximo ciclo
    try {
      await sql`
        UPDATE vigia.bloqueios SET removido = NULL
        WHERE id = ${bloqueioId} AND removido = ${agora}`;
    } catch (e2) {
      console.error(`executor: reversão falhou: ${(e2 as Error).message}`);
    }
    try {
      await auditar(sql, ator, `${acao}_falhou`, b.ip, {
        bloqueioId,
        erro: (e as Error).message,
      });
    } catch (e2) {
      console.error(`executor: auditoria falhou: ${(e2 as Error).message}`);
    }
    throw e;
  }
  await auditar(sql, ator, acao, b.ip, { bloqueioId, jaRemovido, pulouCf });
  return { ok: true, jaRemovido, pulado: false };
}

export async function desfazer(
  deps: ExecutorDeps,
  bloqueioId: number,
  ator: string,
): Promise<{ ok: true; jaRemovido: boolean }> {
  const r = await remover(deps, bloqueioId, ator, "desfazer");
  return { ok: true, jaRemovido: r.jaRemovido };
}

/** Remove bloqueios vencidos (expira <= agora). Devolve quantos foram removidos. */
export async function expirarVencidos(deps: ExecutorDeps): Promise<number> {
  const venc = await deps.sql`
    SELECT id FROM vigia.bloqueios
    WHERE removido IS NULL AND expira IS NOT NULL AND expira <= ${deps.agora()}
    ORDER BY id`;
  let n = 0;
  for (const v of venc) {
    try {
      const r = await remover(deps, Number(v.id), "sistema", "expirar");
      if (!r.pulado) n++;
    } catch (e) {
      console.error(
        `executor: falha ao expirar bloqueio ${v.id}: ${(e as Error).message}`,
      );
    }
  }
  return n;
}
