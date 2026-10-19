// Auditoria anônima de uma instância Supabase self-hosted. O Vigia age como um
// estranho anônimo, usando SÓ a anon key (que é pública por design — a service
// key nunca é usada nem pedida). Reporta o que um anônimo consegue ver/fazer;
// nunca guarda DADO de linha (só a contagem e os nomes de coluna) e nunca
// executa RPC.
//
// Checagens (todas GET, menos o probe de signup que é só leitura de settings):
//  1. PostgREST /rest/v1/  → tabelas/views expostas + funções RPC (da OpenAPI).
//  2. Para cada tabela: select=*&limit=1 com a anon key. Se vier linha → RLS
//     aberto/ausente (lê sem login). Guarda só nº de colunas e seus nomes.
//  3. /auth/v1/settings → signup aberto?
//  4. /auth/v1/admin/users → tem de ser recusado (401/403). 200 = crítico.
//  5. /storage/v1/bucket → lista buckets anonimamente?

import type { Sql } from "../db/client.ts";

export interface InstanciaSupabase {
  nome: string;
  url: string; // https://supabase.exemplo.com.br (sem barra final)
  anonKey: string; // pública
}

const ROTULO = /^[\w .\-]{1,60}$/;

/** Instâncias cadastradas (com a anon key, para rodar a auditoria). */
export async function listarInstancias(
  sql: Sql,
): Promise<InstanciaSupabase[]> {
  const rows = await sql`
    SELECT nome, url, anon_key FROM vigia.supabase_instancias ORDER BY nome`;
  return rows.map((r) => ({
    nome: String(r.nome),
    url: String(r.url),
    anonKey: String(r.anon_key),
  }));
}

/** Cadastra/atualiza uma instância. Valida nome, URL (https) e formato da anon. */
export async function salvarInstancia(
  sql: Sql,
  nome: string,
  urlBruta: string,
  anonKey: string,
): Promise<InstanciaSupabase> {
  const n = nome.trim();
  if (!ROTULO.test(n)) throw new Error("Nome inválido");
  const url = normalizarUrlSupabase(urlBruta);
  const ak = anonKey.trim();
  // anon key do Supabase é um JWT (eyJ...) ou sb_publishable_...; validação leve.
  if (!/^(eyJ[\w.\-]+|sb_[\w.\-]+)$/.test(ak)) {
    throw new Error(
      "Anon key com formato inesperado (esperado JWT eyJ… ou sb_…)",
    );
  }
  await sql`
    INSERT INTO vigia.supabase_instancias (nome, url, anon_key)
    VALUES (${n}, ${url}, ${ak})
    ON CONFLICT (nome) DO UPDATE SET url = EXCLUDED.url,
      anon_key = EXCLUDED.anon_key`;
  return { nome: n, url, anonKey: ak };
}

export async function removerInstancia(
  sql: Sql,
  nome: string,
): Promise<boolean> {
  const r = await sql`
    DELETE FROM vigia.supabase_instancias WHERE nome = ${nome.trim()}
    RETURNING nome`;
  await sql`DELETE FROM vigia.supabase_resultado WHERE instancia = ${nome.trim()}`;
  return r.length > 0;
}

export async function salvarResultado(
  sql: Sql,
  r: ResultadoSupabase,
): Promise<void> {
  await sql`
    INSERT INTO vigia.supabase_resultado (instancia, url, ok, resultado, criado)
    VALUES (${r.instancia}, ${r.url}, ${r.ok}, ${
    // deno-lint-ignore no-explicit-any
    sql.json(JSON.parse(JSON.stringify(r)) as any)}, now())
    ON CONFLICT (instancia) DO UPDATE SET url = EXCLUDED.url,
      ok = EXCLUDED.ok, resultado = EXCLUDED.resultado, criado = now()`;
}

/** Última auditoria de cada instância (sem a anon key). */
export async function listarResultados(sql: Sql): Promise<
  {
    instancia: string;
    url: string;
    criado: string;
    resultado: ResultadoSupabase;
  }[]
> {
  const rows = await sql`
    SELECT instancia, url, criado, resultado
    FROM vigia.supabase_resultado ORDER BY instancia`;
  return rows.map((r) => ({
    instancia: String(r.instancia),
    url: String(r.url),
    criado: new Date(r.criado as string).toISOString(),
    resultado: r.resultado as ResultadoSupabase,
  }));
}

export type SevSupabase =
  | "critica"
  | "alta"
  | "media"
  | "baixa"
  | "informativa";

export interface AchadoSupabase {
  verificacao: string;
  severidade: SevSupabase;
  titulo: string;
  detalhe: string;
  recomendacao: string;
}

export interface ResultadoSupabase {
  instancia: string;
  url: string;
  ok: boolean;
  erro?: string;
  tabelasExpostas: number;
  tabelasAbertas: { tabela: string; colunas: string[] }[];
  rpcAnon: string[];
  achados: AchadoSupabase[];
}

const TIMEOUT_MS = 15_000;

/** URL normalizada (https, sem barra final) ou lança. */
export function normalizarUrlSupabase(bruta: string): string {
  let u: URL;
  try {
    u = new URL(bruta.trim());
  } catch {
    throw new Error("URL inválida");
  }
  if (u.protocol !== "https:") throw new Error("Use https://");
  if (u.username || u.password) throw new Error("URL não pode ter credenciais");
  return `${u.protocol}//${u.host}`;
}

function h(anon: string) {
  return { "apikey": anon, "Authorization": `Bearer ${anon}` };
}

/**
 * Audita uma instância. `fetchFn` é injetável nos testes. Nunca lança por
 * checagem: falha de rede numa etapa não derruba as outras.
 */
export async function auditarSupabase(
  inst: InstanciaSupabase,
  fetchFn: typeof fetch = fetch,
): Promise<ResultadoSupabase> {
  const url = inst.url.replace(/\/+$/, "");
  const achados: AchadoSupabase[] = [];
  const get = (caminho: string, headers: Record<string, string>) =>
    fetchFn(url + caminho, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

  // 1. OpenAPI do PostgREST: tabelas/views + RPC.
  let tabelas: string[] = [];
  let rpcAnon: string[] = [];
  try {
    const r = await get("/rest/v1/", h(inst.anonKey));
    if (r.ok) {
      const doc = await r.json().catch(() => ({})) as {
        definitions?: Record<string, unknown>;
        paths?: Record<string, unknown>;
      };
      tabelas = Object.keys(doc.definitions ?? {});
      rpcAnon = Object.keys(doc.paths ?? {})
        .filter((p) => p.startsWith("/rpc/"))
        .map((p) => p.slice(5));
    } else {
      // PostgREST fechado para anônimo é o estado desejável.
      await r.body?.cancel();
    }
  } catch (e) {
    return {
      instancia: inst.nome,
      url,
      ok: false,
      erro: (e as Error)?.message ?? "falha ao acessar /rest/v1/",
      tabelasExpostas: 0,
      tabelasAbertas: [],
      rpcAnon: [],
      achados,
    };
  }

  if (tabelas.length > 0) {
    achados.push({
      verificacao: "postgrest_exposto",
      severidade: "baixa",
      titulo: `PostgREST expõe ${tabelas.length} tabela(s)/view(s) ao anônimo`,
      detalhe: `A OpenAPI anônima lista: ${tabelas.slice(0, 30).join(", ")}${
        tabelas.length > 30 ? "…" : ""
      }`,
      recomendacao:
        "Normal se o RLS protege cada tabela; o que importa é nenhuma retornar linha sem login (abaixo).",
    });
  }

  // 2. RLS: cada tabela com select limit 1.
  const abertas: { tabela: string; colunas: string[] }[] = [];
  for (const t of tabelas) {
    try {
      const r = await get(
        `/rest/v1/${encodeURIComponent(t)}?select=*&limit=1`,
        h(inst.anonKey),
      );
      if (!r.ok) {
        await r.body?.cancel();
        continue;
      }
      const linhas = await r.json().catch(() => []) as unknown[];
      if (Array.isArray(linhas) && linhas.length > 0) {
        const colunas = linhas[0] && typeof linhas[0] === "object"
          ? Object.keys(linhas[0] as Record<string, unknown>)
          : [];
        abertas.push({ tabela: t, colunas }); // só nomes de coluna, nunca o dado
      }
    } catch { /* falha de rede numa tabela: ignora */ }
  }
  if (abertas.length > 0) {
    achados.push({
      verificacao: "rls_aberto",
      severidade: "alta",
      titulo:
        `${abertas.length} tabela(s) legível(is) sem login (RLS ausente/aberto)`,
      detalhe: "Tabelas que retornaram linha só com a anon key: " +
        abertas.map((a) => `${a.tabela} (${a.colunas.length} col.)`).join(", "),
      recomendacao:
        "Ative RLS e crie policies por tabela (ex.: `alter table X enable row level security;` + policy que exige auth.uid()). Nenhuma tabela com dado de usuário deve responder só com a anon key.",
    });
  }

  // 3. signup aberto?
  try {
    const r = await get("/auth/v1/settings", h(inst.anonKey));
    if (r.ok) {
      const s = await r.json().catch(() => ({})) as {
        disable_signup?: boolean;
        external?: Record<string, unknown>;
      };
      if (s.disable_signup === false) {
        achados.push({
          verificacao: "signup_aberto",
          severidade: "media",
          titulo: "Cadastro (signup) aberto ao público",
          detalhe: "O GoTrue aceita novos cadastros sem convite.",
          recomendacao:
            "Se o app não é de cadastro público, desative o signup (GOTRUE_DISABLE_SIGNUP=true) ou restrinja por convite/domínio.",
        });
      }
    } else {
      await r.body?.cancel();
    }
  } catch { /* ignora */ }

  // 4. /auth/v1/admin/users precisa ser recusado para anônimo.
  try {
    const r = await get("/auth/v1/admin/users", h(inst.anonKey));
    if (r.ok) {
      await r.body?.cancel();
      achados.push({
        verificacao: "admin_users_exposto",
        severidade: "critica",
        titulo: "/auth/v1/admin/users responde ao anônimo",
        detalhe:
          "A API de administração de usuários do GoTrue respondeu 200 só com a anon key — enumera todos os usuários.",
        recomendacao:
          "A rota admin exige a service key no servidor; nunca deve ficar acessível à anon key. Bloqueie /auth/v1/admin no proxy e revise a configuração do GoTrue.",
      });
    } else {
      await r.body?.cancel();
    }
  } catch { /* ignora */ }

  // 5. buckets anônimos.
  try {
    const r = await get("/storage/v1/bucket", h(inst.anonKey));
    if (r.ok) {
      const buckets = await r.json().catch(() => []) as unknown[];
      if (Array.isArray(buckets) && buckets.length > 0) {
        achados.push({
          verificacao: "storage_buckets_anon",
          severidade: "alta",
          titulo: `Storage lista ${buckets.length} bucket(s) ao anônimo`,
          detalhe:
            "GET /storage/v1/bucket respondeu com a lista de buckets só com a anon key.",
          recomendacao:
            "Restrinja a listagem de buckets; mantenha buckets privados e com policies de acesso.",
        });
      }
    } else {
      await r.body?.cancel();
    }
  } catch { /* ignora */ }

  if (rpcAnon.length > 0) {
    achados.push({
      verificacao: "rpc_anon",
      severidade: "media",
      titulo:
        `${rpcAnon.length} função RPC exposta ao anônimo (listada, não executada)`,
      detalhe: "Funções no /rpc/: " + rpcAnon.slice(0, 30).join(", ") +
        (rpcAnon.length > 30 ? "…" : ""),
      recomendacao:
        "Revise cada função: revogue o EXECUTE do papel anon nas que não devem ser públicas (`revoke execute on function X from anon;`).",
    });
  }

  return {
    instancia: inst.nome,
    url,
    ok: true,
    tabelasExpostas: tabelas.length,
    tabelasAbertas: abertas,
    rpcAnon,
    achados,
  };
}
