// Plano de controle de testes ofensivos do Vigia. Aqui só ficam o cadastro, o
// gate de segurança e checagens ATIVAS GENUINAMENTE SEGURAS que um defensor
// roda contra o PRÓPRIO staging. NADA de metasploit/sqlmap/exploit destrutivo
// roda a partir do processo do Vigia: a exploração real exige um runner
// isolado que o Djair opta por usar separadamente.
//
// Gate duro: uma campanha só pode mirar um hostname das zonas que o Vigia
// administra E marcado como ambiente=teste. Produção é sempre recusada, tanto
// ao criar quanto ao autorizar e ao rodar. Autorizar exige um token de
// confirmação explícito.
import type { Sql } from "../db/client.ts";
import { ErroApi } from "../api/servicos.ts";
import { auditar } from "../monitor/executor.ts";
import { base64url, iguaisConstante, sha256Hex } from "../auth/session.ts";
import { normalizarHost, zonaDoHost } from "./execucao.ts";
import {
  type ArquivoExposto,
  type ClienteRede,
  varreduraProfunda,
} from "./varredura.ts";
import type { Achado, ClienteAuditoria } from "./verificacoes.ts";

export type TipoAtaque = "forca_bruta_simulada" | "fuzz_leve" | "enumeracao";
export type EstadoCampanha =
  | "rascunho"
  | "autorizada"
  | "concluida"
  | "cancelada";

export const TIPOS_ATAQUE: TipoAtaque[] = [
  "forca_bruta_simulada",
  "fuzz_leve",
  "enumeracao",
];

export interface Campanha {
  id: number;
  alvo: string;
  host: string;
  tipo: TipoAtaque;
  estado: EstadoCampanha;
  config: Record<string, unknown>;
  autorizadoPor: string | null;
  autorizadoEm: string | null;
  resultado: unknown;
  criadoEm: string | null;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

function linha(r: Record<string, unknown>): Campanha {
  return {
    id: Number(r.id),
    alvo: String(r.alvo),
    host: String(r.host),
    tipo: r.tipo as TipoAtaque,
    estado: r.estado as EstadoCampanha,
    config: (r.config as Record<string, unknown>) ?? {},
    autorizadoPor: (r.autorizado_por as string | null) ?? null,
    autorizadoEm: iso(r.autorizado_em),
    resultado: r.resultado ?? null,
    criadoEm: iso(r.criado_em),
  };
}

/** Hostname do alvo (aceita hostname puro ou URL http/https). */
export function hostDoAlvo(alvo: string): string | null {
  const t = (alvo ?? "").trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    try {
      return normalizarHost(new URL(t).hostname);
    } catch {
      return null;
    }
  }
  return normalizarHost(t);
}

/** Caminho começando com /, sem espaços nem aspas (mesmo formato das exceções). */
const CAMINHO = /^\/[^\s"'\\]*$/;

/**
 * GATE: o host precisa estar numa zona do Vigia E marcado como ambiente=teste
 * (não removido). Qualquer outra coisa (inclusive produção) é recusada. É
 * chamado ao criar, autorizar e rodar.
 */
export async function exigirHostTeste(sql: Sql, host: string): Promise<void> {
  const z = await zonaDoHost(sql, host);
  if (!z) {
    throw new ErroApi(400, {
      erro: "Alvo fora das zonas Cloudflare monitoradas pelo Vigia",
    });
  }
  const [h] = await sql`
    SELECT ambiente, estado FROM vigia.auditoria_hosts WHERE host = ${host}`;
  if (!h || h.estado === "removido" || h.ambiente !== "teste") {
    throw new ErroApi(403, {
      erro:
        "Alvo precisa ser um host de teste/staging (marque o host como ambiente=teste na auditoria). Campanhas contra produção são recusadas.",
    });
  }
}

/** Marca o ambiente de um host auditado (producao|teste). Audita. */
export async function definirAmbienteHost(
  sql: Sql,
  bruto: string,
  ambiente: "producao" | "teste",
  ator: string,
): Promise<{ host: string; ambiente: string }> {
  const host = normalizarHost(bruto);
  if (!host) throw new ErroApi(400, { erro: "Host inválido" });
  const z = await zonaDoHost(sql, host);
  if (!z) {
    throw new ErroApi(400, {
      erro: "Host fora das zonas Cloudflare monitoradas pelo Vigia",
    });
  }
  const r = await sql`
    INSERT INTO vigia.auditoria_hosts (host, zona_id, estado, ambiente)
    VALUES (${host}, ${z.id}, 'confirmado', ${ambiente})
    ON CONFLICT (host) DO UPDATE SET ambiente = ${ambiente},
      atualizado = now()
    RETURNING host`;
  await auditar(sql, ator, "auditoria_host_ambiente", host, { ambiente });
  return { host: String(r[0].host), ambiente };
}

// ----------------------------------------------------------------- CRUD

export async function listarCampanhas(sql: Sql): Promise<Campanha[]> {
  const rows = await sql`
    SELECT id, alvo, host, tipo, estado, config, autorizado_por, autorizado_em,
      resultado, criado_em
    FROM vigia.ataque_campanha ORDER BY id DESC LIMIT 200`;
  return rows.map(linha);
}

export async function verCampanha(sql: Sql, id: number): Promise<Campanha> {
  const [r] = await sql`
    SELECT id, alvo, host, tipo, estado, config, autorizado_por, autorizado_em,
      resultado, criado_em
    FROM vigia.ataque_campanha WHERE id = ${id}`;
  if (!r) throw new ErroApi(404, { erro: "Campanha não encontrada" });
  return linha(r);
}

/** Valida e normaliza a config por tipo (ex.: caminho de login obrigatório). */
function validarConfig(
  tipo: TipoAtaque,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (tipo === "forca_bruta_simulada") {
    const caminho = String(config.caminho ?? "").trim();
    if (!CAMINHO.test(caminho)) {
      throw new ErroApi(400, {
        erro:
          'forca_bruta_simulada exige "caminho": o caminho do login a testar (ex.: /api/login).',
      });
    }
    return { caminho };
  }
  if (tipo === "fuzz_leve") {
    const brutos = Array.isArray(config.caminhos) ? config.caminhos : ["/"];
    const caminhos = brutos.map((x) => String(x).trim()).filter((c) =>
      CAMINHO.test(c)
    ).slice(0, 10);
    if (!caminhos.length) {
      throw new ErroApi(400, {
        erro: "fuzz_leve: informe caminhos válidos (começando com /).",
      });
    }
    return { caminhos };
  }
  return {};
}

export async function criarCampanha(
  sql: Sql,
  v: { alvo: string; tipo: TipoAtaque; config?: Record<string, unknown> },
  ator: string,
): Promise<{ campanha: Campanha; confirmToken: string }> {
  const host = hostDoAlvo(v.alvo);
  if (!host) throw new ErroApi(400, { erro: "Alvo inválido" });
  if (!TIPOS_ATAQUE.includes(v.tipo)) {
    throw new ErroApi(400, { erro: "Tipo de campanha inválido" });
  }
  await exigirHostTeste(sql, host);
  const config = validarConfig(v.tipo, v.config ?? {});
  const confirmToken = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(confirmToken);
  const [r] = await sql`
    INSERT INTO vigia.ataque_campanha
      (alvo, host, tipo, estado, config, confirm_hash)
    VALUES (${v.alvo.trim()}, ${host}, ${v.tipo}, 'rascunho',
      ${sql.json(config as never)}, ${hash})
    RETURNING id, alvo, host, tipo, estado, config, autorizado_por,
      autorizado_em, resultado, criado_em`;
  await auditar(sql, ator, "ataque_criar", String(r.id), {
    alvo: v.alvo,
    tipo: v.tipo,
  });
  return { campanha: linha(r), confirmToken };
}

export async function autorizarCampanha(
  sql: Sql,
  id: number,
  confirmToken: string,
  ator: string,
): Promise<Campanha> {
  const [c] = await sql`
    SELECT id, host, estado, confirm_hash FROM vigia.ataque_campanha
    WHERE id = ${id} FOR UPDATE`;
  if (!c) throw new ErroApi(404, { erro: "Campanha não encontrada" });
  if (c.estado !== "rascunho") {
    throw new ErroApi(409, {
      erro: "Só campanhas em rascunho podem ser autorizadas",
    });
  }
  // Re-confere o gate: o host pode ter virado produção desde a criação.
  await exigirHostTeste(sql, String(c.host));
  const provido = await sha256Hex(String(confirmToken ?? ""));
  if (
    !confirmToken || !await iguaisConstante(provido, String(c.confirm_hash))
  ) {
    throw new ErroApi(403, { erro: "Token de confirmação inválido" });
  }
  await sql`
    UPDATE vigia.ataque_campanha
    SET estado = 'autorizada', autorizado_por = ${ator}, autorizado_em = now()
    WHERE id = ${id}`;
  await auditar(sql, ator, "ataque_autorizar", String(id), {});
  return await verCampanha(sql, id);
}

export async function cancelarCampanha(
  sql: Sql,
  id: number,
  ator: string,
): Promise<Campanha> {
  const r = await sql`
    UPDATE vigia.ataque_campanha SET estado = 'cancelada'
    WHERE id = ${id} AND estado IN ('rascunho', 'autorizada')
    RETURNING id`;
  if (!r.length) {
    const [c] = await sql`
      SELECT estado FROM vigia.ataque_campanha WHERE id = ${id}`;
    throw new ErroApi(c ? 409 : 404, {
      erro: c
        ? `Campanha ${c.estado}: não pode ser cancelada`
        : "Campanha não encontrada",
    });
  }
  await auditar(sql, ator, "ataque_cancelar", String(id), {});
  return await verCampanha(sql, id);
}

// --------------------------------------------------------- execução segura

export interface DepsAtaque {
  http: ClienteAuditoria;
  rede: ClienteRede;
  /**
   * POST ao caminho de login com credenciais FALSAS e UA da auditoria, só para
   * verificar se o rate limit bloqueia. Nunca usa credenciais reais.
   */
  tentarLogin(url: string): Promise<{ status: number }>;
  dormir?: (ms: number) => Promise<void>;
}

const MAX_TENTATIVAS = 25;
const JANELA_MS = 10_000;

/** Caminhos extra para a enumeração (mais agressiva que a varredura diária). */
export const CAMINHOS_ENUMERACAO: ArquivoExposto[] = [
  {
    caminho: "/.env.production",
    severidade: "alta",
    titulo: "Arquivo .env.production público",
    recomendacao:
      "Remova o arquivo da raiz pública e troque as chaves: considere-as vazadas.",
    assinatura: (b) =>
      /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=/m.test(
        new TextDecoder("latin1").decode(b),
      ) && !/<html[\s>]|<!doctype/i.test(new TextDecoder().decode(b)),
  },
  {
    caminho: "/.git/HEAD",
    severidade: "alta",
    titulo: "Repositório .git público (HEAD)",
    recomendacao:
      "Não publique a pasta .git: o código e o histórico podem ser baixados.",
    assinatura: (b) =>
      /^(ref:\s*refs\/|[0-9a-f]{40}\s*$)/.test(
        new TextDecoder("latin1").decode(b).trimStart(),
      ),
  },
  {
    caminho: "/.aws/config",
    severidade: "media",
    titulo: "Config da AWS público",
    recomendacao: "Remova /.aws/config da raiz pública.",
    assinatura: (b) =>
      /\[profile |region\s*=|output\s*=/i.test(
        new TextDecoder("latin1").decode(b),
      ),
  },
];

/** Query strings malformadas (sem corpo, sem bypass de auth): só status. */
const FUZZ_QUERIES = [
  "fuzz=%27",
  "fuzz[]=1",
  "fuzz=%3Cx%3E",
  "fuzz=../../",
  "fuzz=%00",
  "fuzz=" + "A".repeat(2048),
];

/**
 * Executa a checagem ATIVA SEGURA da campanha (já autorizada e com o host de
 * teste revalidado pelo chamador). Devolve o resultado para gravar em
 * `resultado`. Nenhuma destas faz escrita, bypass de auth ou payload de
 * exploit.
 */
export async function executarCampanhaSegura(
  campanha: Campanha,
  deps: DepsAtaque,
): Promise<Record<string, unknown>> {
  const dormir = deps.dormir ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const host = campanha.host;

  if (campanha.tipo === "enumeracao") {
    const { achados, avaliadas } = await varreduraProfunda(
      host,
      deps.http,
      deps.rede,
      new Date(),
      { caminhosExtra: CAMINHOS_ENUMERACAO },
    );
    return {
      tipo: "enumeracao",
      avaliadas: avaliadas.length,
      achados: achados.map((a: Achado) => ({
        verificacao: a.verificacao,
        severidade: a.severidade,
        titulo: a.titulo,
      })),
    };
  }

  if (campanha.tipo === "fuzz_leve") {
    const caminhos = Array.isArray(campanha.config.caminhos)
      ? (campanha.config.caminhos as string[])
      : ["/"];
    const requisicoes: { url: string; status: number }[] = [];
    for (const caminho of caminhos) {
      for (const q of FUZZ_QUERIES) {
        const url = `https://${host}${caminho}${
          caminho.includes("?") ? "&" : "?"
        }${q}`;
        let status = 0;
        try {
          status = (await deps.http.requisitar(url, { limiteBytes: 0 })).status;
        } catch {
          status = -1; // erro de rede
        }
        requisicoes.push({ url, status });
        await dormir(JANELA_MS / MAX_TENTATIVAS); // ~2,5 req/s
      }
    }
    return {
      tipo: "fuzz_leve",
      total: requisicoes.length,
      requisicoes,
      observacao:
        "Só status de GETs com query malformada; nenhum corpo de payload, escrita ou bypass.",
    };
  }

  // forca_bruta_simulada: testa o PRÓPRIO rate limit de login.
  const caminho = String(campanha.config.caminho ?? "/");
  const url = `https://${host}${caminho}`;
  let bloqueouApos: number | null = null;
  let tentativas = 0;
  for (let i = 1; i <= MAX_TENTATIVAS; i++) {
    tentativas = i;
    let status = 0;
    try {
      status = (await deps.tentarLogin(url)).status;
    } catch {
      status = -1;
    }
    if (status === 429 || status === 403) {
      bloqueouApos = i;
      break;
    }
    if (i < MAX_TENTATIVAS) await dormir(JANELA_MS / MAX_TENTATIVAS);
  }
  return {
    tipo: "forca_bruta_simulada",
    caminho,
    tentativas,
    bloqueouApos,
    defesaOk: bloqueouApos !== null,
    observacao: bloqueouApos !== null
      ? `O rate limit bloqueou na tentativa ${bloqueouApos} (credenciais falsas).`
      : "ATENÇÃO: 25 tentativas de login passaram sem bloqueio; reforce o rate limit.",
  };
}

/**
 * Roda uma campanha autorizada: revalida o gate (host ainda de teste), executa
 * a checagem segura via `executar` (injetado), grava o resultado e marca como
 * concluída. Se a execução falhar, a campanha segue autorizada para nova
 * tentativa.
 */
export async function rodarCampanha(
  sql: Sql,
  id: number,
  executar: (c: Campanha) => Promise<Record<string, unknown>>,
  ator: string,
): Promise<Campanha> {
  const [c] = await sql`
    SELECT id, alvo, host, tipo, estado, config, autorizado_por, autorizado_em,
      resultado, criado_em
    FROM vigia.ataque_campanha WHERE id = ${id}`;
  if (!c) throw new ErroApi(404, { erro: "Campanha não encontrada" });
  if (c.estado !== "autorizada") {
    throw new ErroApi(409, {
      erro: "Só campanhas autorizadas podem rodar",
    });
  }
  // Gate duro no momento de rodar.
  await exigirHostTeste(sql, String(c.host));
  const campanha = linha(c);
  let resultado: Record<string, unknown>;
  try {
    resultado = await executar(campanha);
  } catch (e) {
    await auditar(sql, ator, "ataque_rodar", String(id), {
      erro: (e as Error)?.message ?? String(e),
    });
    throw new ErroApi(502, {
      erro: `Falha ao rodar a campanha: ${(e as Error)?.message ?? e}`,
    });
  }
  await sql`
    UPDATE vigia.ataque_campanha
    SET estado = 'concluida', resultado = ${sql.json(resultado as never)}
    WHERE id = ${id}`;
  await auditar(sql, ator, "ataque_rodar", String(id), { tipo: campanha.tipo });
  return await verCampanha(sql, id);
}
