// Acesso a correio.assinaturas (2.0) e escolha da assinatura de um envio.
import type { Sql } from "../db/client.ts";
import { type CamposAssinatura, gerarAssinatura } from "./assinatura.ts";
import {
  type AssinaturaGerada,
  type CamposAssinatura2,
  gerarAssinaturaModelo,
  type Modelo,
} from "./modelos_assinatura.ts";
import { type CaixaPublica, lerImagem } from "./repo.ts";

/** Teto de assinaturas por caixa. */
export const MAX_ASSINATURAS = 50;

export interface AssinaturaSalva {
  id: number;
  caixaId: number;
  nome: string;
  modelo: Modelo;
  campos: CamposAssinatura2;
  temLogoPropria: boolean;
  padraoNova: boolean;
  padraoResposta: boolean;
  criadoEm: string;
  atualizadoEm: string;
}

export interface Padroes {
  nova: number | null;
  resposta: number | null;
}

export class LimiteAssinaturas extends Error {
  constructor() {
    super(`No máximo ${MAX_ASSINATURAS} assinaturas por caixa`);
    this.name = "LimiteAssinaturas";
  }
}

interface Linha {
  id: number;
  caixa_id: number;
  nome: string;
  modelo: Modelo;
  campos: CamposAssinatura2;
  tem_logo: boolean;
  padrao_nova: boolean;
  padrao_resposta: boolean;
  criado_em: Date;
  atualizado_em: Date;
}

const COLUNAS = (sql: Sql) =>
  sql`a.id, a.caixa_id, a.nome, a.modelo, a.campos,
    a.logo IS NOT NULL AS tem_logo,
    c.assinatura_nova_id IS NOT DISTINCT FROM a.id AS padrao_nova,
    c.assinatura_resposta_id IS NOT DISTINCT FROM a.id AS padrao_resposta,
    a.criado_em, a.atualizado_em`;

function publica(l: Linha): AssinaturaSalva {
  return {
    id: l.id,
    caixaId: l.caixa_id,
    nome: l.nome,
    modelo: l.modelo,
    campos: l.campos ?? {},
    temLogoPropria: l.tem_logo,
    padraoNova: l.padrao_nova,
    padraoResposta: l.padrao_resposta,
    criadoEm: new Date(l.criado_em).toISOString(),
    atualizadoEm: new Date(l.atualizado_em).toISOString(),
  };
}

export async function listarAssinaturas(
  sql: Sql,
  caixaId: number,
): Promise<AssinaturaSalva[]> {
  const rs = await sql<Linha[]>`SELECT ${COLUNAS(sql)}
    FROM correio.assinaturas a JOIN correio.caixas c ON c.id = a.caixa_id
    WHERE a.caixa_id = ${caixaId} ORDER BY a.id`;
  return rs.map(publica);
}

export async function obterAssinatura(
  sql: Sql,
  caixaId: number,
  id: number,
): Promise<AssinaturaSalva | null> {
  const [l] = await sql<Linha[]>`SELECT ${COLUNAS(sql)}
    FROM correio.assinaturas a JOIN correio.caixas c ON c.id = a.caixa_id
    WHERE a.caixa_id = ${caixaId} AND a.id = ${id}`;
  return l ? publica(l) : null;
}

export async function lerPadroes(
  sql: Sql,
  caixaId: number,
): Promise<Padroes | null> {
  const [l] = await sql<
    { nova: number | null; resposta: number | null }[]
  >`SELECT assinatura_nova_id AS nova, assinatura_resposta_id AS resposta
    FROM correio.caixas WHERE id = ${caixaId}`;
  return l ? { nova: l.nova, resposta: l.resposta } : null;
}

/**
 * Cria. A primeira assinatura da caixa vira padrão de novas e de respostas
 * (quando ainda não há padrão).
 */
export async function criarAssinatura(
  sql: Sql,
  caixaId: number,
  n: { nome: string; modelo: Modelo; campos: CamposAssinatura2 },
): Promise<AssinaturaSalva | null> {
  const id = await sql.begin(async (tx) => {
    const [cx] = await tx`SELECT id FROM correio.caixas
      WHERE id = ${caixaId} FOR UPDATE`;
    if (!cx) return null;
    const [q] = await tx`SELECT count(*)::int n FROM correio.assinaturas
      WHERE caixa_id = ${caixaId}`;
    if (q.n >= MAX_ASSINATURAS) throw new LimiteAssinaturas();
    const [l] = await tx`INSERT INTO correio.assinaturas
      (caixa_id, nome, modelo, campos)
      VALUES (${caixaId}, ${n.nome}, ${n.modelo}, ${tx.json(n.campos as never)})
      RETURNING id`;
    await tx`UPDATE correio.caixas SET
      assinatura_nova_id = coalesce(assinatura_nova_id, ${l.id}),
      assinatura_resposta_id = coalesce(assinatura_resposta_id, ${l.id})
      WHERE id = ${caixaId}`;
    return l.id as number;
  });
  return id === null ? null : await obterAssinatura(sql, caixaId, id);
}

export async function atualizarAssinatura(
  sql: Sql,
  caixaId: number,
  id: number,
  a: { nome?: string; modelo?: Modelo; campos?: CamposAssinatura2 },
): Promise<AssinaturaSalva | null> {
  const set: Record<string, unknown> = { atualizado_em: new Date() };
  if (a.nome !== undefined) set.nome = a.nome;
  if (a.modelo !== undefined) set.modelo = a.modelo;
  if (a.campos !== undefined) set.campos = sql.json(a.campos as never);
  const r = await sql`UPDATE correio.assinaturas SET ${sql(set)}
    WHERE id = ${id} AND caixa_id = ${caixaId}`;
  return r.count ? await obterAssinatura(sql, caixaId, id) : null;
}

/** Remove; o padrão que apontava para ela vira null (FK ON DELETE SET NULL). */
export async function removerAssinatura(
  sql: Sql,
  caixaId: number,
  id: number,
): Promise<boolean> {
  const r = await sql`DELETE FROM correio.assinaturas
    WHERE id = ${id} AND caixa_id = ${caixaId}`;
  return r.count > 0;
}

/**
 * Define os padrões. Um id que não é desta caixa → "invalida"; caixa
 * inexistente → "caixa".
 */
export async function definirPadroes(
  sql: Sql,
  caixaId: number,
  p: Padroes,
): Promise<"ok" | "caixa" | "invalida"> {
  return await sql.begin(async (tx) => {
    const [cx] = await tx`SELECT id FROM correio.caixas
      WHERE id = ${caixaId} FOR UPDATE`;
    if (!cx) return "caixa" as const;
    for (const id of [p.nova, p.resposta]) {
      if (id === null) continue;
      const [a] = await tx`SELECT 1 FROM correio.assinaturas
        WHERE id = ${id} AND caixa_id = ${caixaId}`;
      if (!a) return "invalida" as const;
    }
    await tx`UPDATE correio.caixas SET assinatura_nova_id = ${p.nova},
      assinatura_resposta_id = ${p.resposta} WHERE id = ${caixaId}`;
    return "ok" as const;
  });
}

export async function salvarLogoAssinatura(
  sql: Sql,
  caixaId: number,
  id: number,
  logo: { bytes: Uint8Array; mime: string } | null,
): Promise<boolean> {
  const r = await sql`UPDATE correio.assinaturas
    SET logo = ${logo?.bytes ?? null}, logo_tipo = ${logo?.mime ?? null},
      atualizado_em = now()
    WHERE id = ${id} AND caixa_id = ${caixaId}`;
  return r.count > 0;
}

export async function lerLogoAssinatura(
  sql: Sql,
  caixaId: number,
  id: number,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const [l] = await sql`SELECT logo AS b, logo_tipo AS t
    FROM correio.assinaturas WHERE id = ${id} AND caixa_id = ${caixaId}`;
  if (!l || l.b === null || l.t === null) return null;
  return { bytes: new Uint8Array(l.b), mime: l.t };
}

/** Bytes do logo conforme campos.logo (padrão "caixa"). */
export async function logoDaAssinatura(
  sql: Sql,
  caixa: Pick<CaixaPublica, "id" | "tem_logo">,
  campos: CamposAssinatura2,
  assinaturaId: number | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const origem = campos.logo ?? "caixa";
  if (origem === "nenhum") return null;
  if (origem === "propria") {
    return assinaturaId === null
      ? null
      : await lerLogoAssinatura(sql, caixa.id, assinaturaId);
  }
  return caixa.tem_logo ? await lerImagem(sql, caixa.id, "logo") : null;
}

export async function gerarSalva(
  sql: Sql,
  caixa: Pick<CaixaPublica, "id" | "tem_logo" | "cor">,
  a: Pick<AssinaturaSalva, "id" | "modelo" | "campos">,
  imagens: "cid" | "dataUri" = "cid",
): Promise<AssinaturaGerada> {
  const logo = await logoDaAssinatura(sql, caixa, a.campos, a.id);
  return gerarAssinaturaModelo(a.modelo, a.campos, {
    logo,
    imagens,
    corPadrao: caixa.cor,
  });
}

/** Assinatura 1.0 (campos em caixas.assinatura), usada só sem assinaturas 2.0. */
export interface AssinaturaLegada {
  campos: CamposAssinatura;
  logo: { bytes: Uint8Array; mime: string } | null;
}

/**
 * A assinatura de um envio:
 * - `escolha` número → essa (se não existir mais, cai no padrão);
 * - `escolha` null → nenhuma;
 * - `escolha` ausente → padrão de novas ou de respostas/encaminhamentos.
 * Caixa sem nenhuma assinatura 2.0 (criada depois da migração e nunca
 * configurada no estúdio) → campos 1.0, se houver. Sem nada → null.
 */
export async function assinaturaParaEnvio(
  sql: Sql,
  caixa: CaixaPublica,
  modo: "nova" | "resposta",
  escolha: number | null | undefined,
): Promise<AssinaturaGerada | AssinaturaLegada | null> {
  if (escolha === null) return null;
  let a: AssinaturaSalva | null = null;
  if (typeof escolha === "number") {
    a = await obterAssinatura(sql, caixa.id, escolha);
  }
  if (!a) {
    const p = await lerPadroes(sql, caixa.id);
    const id = modo === "nova" ? p?.nova : p?.resposta;
    if (id) a = await obterAssinatura(sql, caixa.id, id);
  }
  if (a) return await gerarSalva(sql, caixa, a, "cid");
  const [q] = await sql`SELECT count(*)::int n FROM correio.assinaturas
    WHERE caixa_id = ${caixa.id}`;
  if (q.n > 0) return null; // tem assinaturas, mas nenhum padrão para o modo
  const campos = caixa.assinatura ?? {};
  if (!gerarAssinatura(campos).texto) return null;
  const img = campos.incluirLogo && caixa.tem_logo
    ? await lerImagem(sql, caixa.id, "logo")
    : null;
  return { campos, logo: img };
}
