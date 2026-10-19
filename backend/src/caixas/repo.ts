// Acesso a correio.caixas. A senha só sai daqui por lerSenha (decifrada,
// para conectar); os objetos públicos nunca a carregam.
import type { Sql } from "../db/client.ts";
import { decrypt, encrypt } from "../crypto/vault.ts";
import type { CamposAssinatura } from "./assinatura.ts";
import type { TipoImagem } from "./marca.ts";

export type EstadoCaixa = "ok" | "precisa_senha" | "erro";

export interface CaixaPublica {
  id: number;
  endereco: string;
  dominio: string;
  nome_exibicao: string;
  estado: EstadoCaixa;
  /** Observação em pt-BR sobre o estado (ex.: senha ilegível); null se nada. */
  estado_motivo: string | null;
  /** #rrggbb ou null (o PWA extrai a cor do logo e grava por PATCH). */
  cor: string | null;
  tem_logo: boolean;
  tem_favicon: boolean;
  assinatura: CamposAssinatura;
  ordem: number;
  criado_em: Date;
}

export interface NovaCaixa {
  endereco: string;
  senha: string;
  nome_exibicao?: string;
  cor?: string | null;
  ordem?: number;
}

export interface AlteracaoCaixa {
  nome_exibicao?: string;
  /** Recifra; o estado não muda aqui (o chamador testa e grava o resultado). */
  senha?: string;
  cor?: string | null;
  ordem?: number;
}

export const MOTIVO_SENHA_ILEGIVEL = "senha precisa ser digitada de novo";

/**
 * A senha guardada não decifra com a chave mestra atual (volume /data
 * perdido → nova CORREIO_MASTER_KEY). Não adianta repetir: a caixa vai a
 * precisa_senha com MOTIVO_SENHA_ILEGIVEL até o usuário digitar a senha.
 */
export class SenhaIlegivel extends Error {
  constructor() {
    super(MOTIVO_SENHA_ILEGIVEL);
    this.name = "SenhaIlegivel";
  }
}

export class EnderecoDuplicado extends Error {
  constructor() {
    super("Já existe uma caixa com esse endereço");
    this.name = "EnderecoDuplicado";
  }
}

const COLUNAS = (sql: Sql) =>
  sql`id, endereco, nome_exibicao, estado, estado_motivo, cor, ordem,
    criado_em, assinatura,
    logo IS NOT NULL AS tem_logo, favicon IS NOT NULL AS tem_favicon`;

type Linha = Omit<CaixaPublica, "dominio">;

function publica(l: Linha): CaixaPublica {
  return {
    id: l.id,
    endereco: l.endereco,
    dominio: l.endereco.slice(l.endereco.lastIndexOf("@") + 1),
    nome_exibicao: l.nome_exibicao,
    estado: l.estado,
    estado_motivo: l.estado_motivo ?? null,
    cor: l.cor,
    tem_logo: l.tem_logo,
    tem_favicon: l.tem_favicon,
    assinatura: l.assinatura ?? {},
    ordem: l.ordem,
    criado_em: l.criado_em,
  };
}

export const normalizarEndereco = (e: string) => e.trim().toLowerCase();

export async function listarCaixas(sql: Sql): Promise<CaixaPublica[]> {
  const rs = await sql<Linha[]>`SELECT ${COLUNAS(sql)} FROM correio.caixas
    ORDER BY ordem, id`;
  return rs.map(publica);
}

export async function obterCaixa(
  sql: Sql,
  id: number,
): Promise<CaixaPublica | null> {
  const [l] = await sql<Linha[]>`SELECT ${COLUNAS(sql)} FROM correio.caixas
    WHERE id = ${id}`;
  return l ? publica(l) : null;
}

export async function criarCaixa(
  sql: Sql,
  chave: Uint8Array,
  n: NovaCaixa,
): Promise<CaixaPublica> {
  try {
    const [l] = await sql<Linha[]>`INSERT INTO correio.caixas
      (endereco, senha_cifrada, nome_exibicao, cor, ordem)
      VALUES (${normalizarEndereco(n.endereco)}, ${encrypt(n.senha, chave)},
        ${n.nome_exibicao ?? ""}, ${n.cor ?? null}, ${n.ordem ?? 0})
      RETURNING ${COLUNAS(sql)}`;
    return publica(l);
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      throw new EnderecoDuplicado();
    }
    throw e;
  }
}

export async function atualizarCaixa(
  sql: Sql,
  chave: Uint8Array,
  id: number,
  a: AlteracaoCaixa,
): Promise<CaixaPublica | null> {
  const set: Record<string, unknown> = {};
  if (a.nome_exibicao !== undefined) set.nome_exibicao = a.nome_exibicao;
  if (a.cor !== undefined) set.cor = a.cor;
  if (a.ordem !== undefined) set.ordem = a.ordem;
  if (a.senha !== undefined) {
    set.senha_cifrada = encrypt(a.senha, chave);
    set.estado_motivo = null;
  }
  if (Object.keys(set).length === 0) return await obterCaixa(sql, id);
  const [l] = await sql<Linha[]>`UPDATE correio.caixas SET ${sql(set)}
    WHERE id = ${id} RETURNING ${COLUNAS(sql)}`;
  return l ? publica(l) : null;
}

export async function removerCaixa(sql: Sql, id: number): Promise<boolean> {
  const r = await sql`DELETE FROM correio.caixas WHERE id = ${id}`;
  return r.count > 0;
}

export async function definirEstado(
  sql: Sql,
  id: number,
  estado: EstadoCaixa,
): Promise<void> {
  await sql`UPDATE correio.caixas SET estado = ${estado}, estado_motivo = NULL
    WHERE id = ${id}`;
}

/**
 * Endereço e senha decifrada, para conectar. Nunca devolva isso ao cliente.
 * Senha que não decifra (chave mestra trocada, token corrompido): marca
 * precisa_senha com motivo (se a senha ainda é a mesma) e lança
 * SenhaIlegivel — quem chama para de tentar, sem laço de erros.
 */
export async function lerSenha(
  sql: Sql,
  chave: Uint8Array,
  id: number,
): Promise<{ endereco: string; senha: string; senhaCifrada: string } | null> {
  const [l] = await sql<{ endereco: string; senha_cifrada: string }[]>`
    SELECT endereco, senha_cifrada FROM correio.caixas WHERE id = ${id}`;
  if (!l) return null;
  let senha: string;
  try {
    senha = decrypt(l.senha_cifrada, chave);
  } catch (e) {
    if (chave.length !== 32) throw e; // erro de configuração, não da caixa
    console.error(
      `[caixas] caixa ${id}: senha guardada ilegível:`,
      (e as { code?: string })?.code ?? (e as Error)?.name,
    );
    await sql`UPDATE correio.caixas
      SET estado = 'precisa_senha', estado_motivo = ${MOTIVO_SENHA_ILEGIVEL}
      WHERE id = ${id} AND senha_cifrada = ${l.senha_cifrada}`;
    throw new SenhaIlegivel();
  }
  return { endereco: l.endereco, senha, senhaCifrada: l.senha_cifrada };
}

/**
 * precisa_senha só se a senha guardada ainda é `senhaCifrada` (a recusada):
 * uma troca feita no meio da tentativa não é sobrescrita. true = gravou.
 */
export async function marcarPrecisaSenha(
  sql: Sql,
  id: number,
  senhaCifrada: string,
): Promise<boolean> {
  const r = await sql`UPDATE correio.caixas
    SET estado = 'precisa_senha', estado_motivo = NULL
    WHERE id = ${id} AND senha_cifrada = ${senhaCifrada}`;
  return r.count === 1;
}

export async function salvarImagem(
  sql: Sql,
  id: number,
  tipo: TipoImagem,
  bytes: Uint8Array,
  mime: string,
): Promise<boolean> {
  const r = tipo === "logo"
    ? await sql`UPDATE correio.caixas SET logo = ${bytes}, logo_tipo = ${mime}
      WHERE id = ${id}`
    : await sql`UPDATE correio.caixas SET favicon = ${bytes},
      favicon_tipo = ${mime} WHERE id = ${id}`;
  return r.count > 0;
}

export async function lerImagem(
  sql: Sql,
  id: number,
  tipo: TipoImagem,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const [l] = tipo === "logo"
    ? await sql`SELECT logo AS b, logo_tipo AS t FROM correio.caixas
      WHERE id = ${id}`
    : await sql`SELECT favicon AS b, favicon_tipo AS t FROM correio.caixas
      WHERE id = ${id}`;
  if (!l || l.b === null || l.t === null) return null;
  return { bytes: new Uint8Array(l.b), mime: l.t };
}

export async function salvarAssinatura(
  sql: Sql,
  id: number,
  campos: CamposAssinatura,
): Promise<boolean> {
  const r = await sql`UPDATE correio.caixas
    SET assinatura = ${sql.json(campos as never)} WHERE id = ${id}`;
  return r.count > 0;
}
