import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import { corpo, limiteCorpo } from "./util.ts";
import {
  atualizarCaixa,
  criarCaixa,
  definirEstado,
  EnderecoDuplicado,
  type EstadoCaixa,
  lerImagem,
  lerSenha,
  listarCaixas,
  obterCaixa,
  removerCaixa,
  salvarAssinatura,
  salvarImagem,
  SenhaIlegivel,
} from "../caixas/repo.ts";
import {
  LIMITES,
  MENSAGEM,
  type TipoImagem,
  validarImagem,
} from "../caixas/marca.ts";
import { CID_LOGO, gerarAssinatura } from "../caixas/assinatura.ts";
import type {
  ConfigMail,
  ResultadoTeste,
  TestarCaixa,
} from "../mail/conexao.ts";
import type { SincronizadorCaixas } from "../mail/vigia_caixa.ts";
import { MENSAGEM_SENHA_ILEGIVEL } from "../mail/pool.ts";
import type { ResendConfig } from "../mail/resend.ts";
import { resolverRemetenteDb } from "../mail/resend_contas.ts";
import {
  configPosteAdmin,
  criarCaixaPoste,
  definirSenhaCaixaPoste,
  ErroPosteAdmin,
  garantirDominioPoste,
  listarCaixasPoste,
  senhaNova,
} from "../mail/poste_admin.ts";

export interface CaixasDeps {
  sql: Sql;
  masterKey: Uint8Array;
  mail: ConfigMail;
  testarCaixa: TestarCaixa;
  /** Vigia da INBOX: sync após criar, editar, testar ou remover. */
  vigia?: SincronizadorCaixas;
  /** Contas Resend por domínio: o teste verifica o caminho de envio resolvido. */
  resend?: ResendConfig;
}

export { CID_LOGO };

const Cor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor deve ser #rrggbb")
  .transform((s) => s.toLowerCase());
const Nome = z.string().trim().max(100);
const Ordem = z.number().int().min(-1000).max(1000);
const Senha = z.string().min(1).max(500);

const Nova = z.object({
  endereco: z.string().trim().email().max(254),
  senha: Senha,
  nome_exibicao: Nome.optional(),
  cor: Cor.nullable().optional(),
  ordem: Ordem.optional(),
});

const Alteracao = z.object({
  nome_exibicao: Nome.optional(),
  senha: Senha.optional(),
  cor: Cor.nullable().optional(),
  ordem: Ordem.optional(),
});

const Assinatura = z.object({
  nome: z.string().max(200).optional(),
  cargo: z.string().max(200).optional(),
  telefone: z.string().max(60).optional(),
  site: z.string().max(300).optional(),
  extra: z.string().max(300).optional(),
  incluirLogo: z.boolean().optional(),
});

/** Folga para o envelope multipart acima do limite da imagem. */
const FOLGA_MULTIPART = 64 * 1024;

function idDe(c: Context): number | null {
  const p = c.req.param("id") ?? "";
  return /^\d{1,9}$/.test(p) ? Number(p) : null;
}

const naoEncontrada = (c: Context) =>
  c.json({ erro: "Caixa não encontrada" }, 404);

async function auditarSemFalhar(
  sql: Sql,
  acao: string,
  alvo: string,
  detalhes: Record<string, unknown> | null = null,
) {
  try {
    await auditar(sql, "usuario", acao, alvo, detalhes);
  } catch (e) {
    console.error(`[caixas] falha ao auditar ${acao}:`, (e as Error)?.name);
  }
}

/** /api/caixas/* — exige sessão (aplicada em criarApp). */
export function rotasCaixas(d: CaixasDeps): Hono {
  const { sql } = d;
  const app = new Hono();
  const json = limiteCorpo();

  /** Avisa o vigia sem segurar a resposta (parar pode levar até 5 s). */
  const sincronizar = (id: number) => {
    d.vigia?.sync(id).catch((e) =>
      console.error("[caixas] sync do vigia:", (e as Error)?.name)
    );
  };

  /** Testa IMAP+SMTP e grava o estado: senha recusada → precisa_senha. */
  async function testarEGravar(
    id: number,
    endereco: string,
    senha: string,
  ): Promise<ResultadoTeste> {
    let r: ResultadoTeste;
    try {
      // mapeamento do banco tem precedência sobre as variáveis RESEND_CONTA_*
      const rota = await resolverRemetenteDb(sql, d.resend, endereco);
      r = await d.testarCaixa(d.mail, { endereco }, senha, { rota });
    } catch (e) {
      console.error("[caixas] teste de conexão falhou:", (e as Error)?.name);
      r = { imap: false, smtp: false, erro: "falha ao testar a conexão" };
    }
    const estado: EstadoCaixa = r.falhaAutenticacao
      ? "precisa_senha"
      : r.imap && r.smtp
      ? "ok"
      : "erro";
    await definirEstado(sql, id, estado);
    return r;
  }

  app.get("/", async (c) => c.json({ caixas: await listarCaixas(sql) }));

  // Importa do poste.io todas as caixas que ainda não estão no Correio, entrando
  // em cada uma com POSTE_SENHA_CAIXAS (ou a senha enviada). Caixa cuja senha não
  // confere NÃO é adicionada. Para após 3 recusas seguidas, para não acionar o
  // bloqueio de força bruta do poste.io.
  app.get("/poste", async (c) => {
    const cfg = configPosteAdmin(d.mail.imapHost);
    if (!cfg) {
      return c.json({ erro: "Defina POSTE_ADMIN_USUARIO e POSTE_ADMIN_SENHA no app do Correio" }, 503);
    }
    try {
      const doPoste = await listarCaixasPoste(cfg);
      const ja = new Set((await listarCaixas(sql)).map((x) => x.endereco));
      return c.json({
        caixas: doPoste.map((x) => ({ ...x, noCorreio: ja.has(x.endereco) })),
      });
    } catch (e) {
      if (e instanceof ErroPosteAdmin) {
        return c.json({ erro: e.message }, e.status === 401 ? 401 : 502);
      }
      throw e;
    }
  });

  // Cria caixa NOVA no poste.io (e o domínio, se faltar) com senha forte gerada,
  // e já adiciona ao Correio. Nunca mexe em caixa que já existe.
  app.post("/poste/criar", json, async (c) => {
    const cfg = configPosteAdmin(d.mail.imapHost);
    if (!cfg) {
      return c.json({ erro: "Defina POSTE_ADMIN_USUARIO e POSTE_ADMIN_SENHA no app do Correio" }, 503);
    }
    const b = await corpo(c, z.object({ endereco: z.string().trim().toLowerCase().email().max(254), nome_exibicao: Nome.optional() }));
    if (!b.ok) return b.r;
    const endereco = b.v.endereco;
    const senha = senhaNova();
    try {
      const dominio = endereco.split("@")[1];
      const dom = await garantirDominioPoste(cfg, dominio);
      await criarCaixaPoste(cfg, endereco, b.v.nome_exibicao ?? "", senha);
      await auditarSemFalhar(sql, "caixa_criada_poste", endereco, { dominio: dom });
    } catch (e) {
      if (e instanceof ErroPosteAdmin) {
        return c.json({ erro: e.message }, e.status === 409 ? 409 : e.status === 401 ? 401 : 502);
      }
      throw e;
    }
    let caixa;
    try {
      caixa = await criarCaixa(sql, d.masterKey, { endereco, senha, nome_exibicao: b.v.nome_exibicao });
    } catch (e) {
      if (e instanceof EnderecoDuplicado) return c.json({ erro: e.message }, 409);
      throw e;
    }
    const teste = await testarEGravar(caixa.id, caixa.endereco, senha);
    sincronizar(caixa.id);
    // A senha volta UMA vez (para usar no webmail, se quiser); no Correio fica cifrada.
    return c.json({ caixa: await obterCaixa(sql, caixa.id), teste, senha }, 201);
  });

  // Troca a senha de uma caixa que JÁ existe no poste.io e a adiciona (ou atualiza)
  // no Correio. Ação explícita: quem usa a senha antiga em outro app precisa da nova.
  app.post("/poste/senha", json, async (c) => {
    const cfg = configPosteAdmin(d.mail.imapHost);
    if (!cfg) {
      return c.json({ erro: "Defina POSTE_ADMIN_USUARIO e POSTE_ADMIN_SENHA no app do Correio" }, 503);
    }
    const b = await corpo(c, z.object({
      endereco: z.string().trim().toLowerCase().email().max(254),
      senha: z.string().min(10).max(200),
      nome_exibicao: Nome.optional(),
    }));
    if (!b.ok) return b.r;
    try {
      await definirSenhaCaixaPoste(cfg, b.v.endereco, b.v.senha);
    } catch (e) {
      if (e instanceof ErroPosteAdmin) {
        return c.json({ erro: e.message }, e.status === 404 ? 404 : e.status === 401 ? 401 : 502);
      }
      throw e;
    }
    await auditarSemFalhar(sql, "caixa_senha_poste", b.v.endereco);
    const existente = (await listarCaixas(sql)).find((x) => x.endereco === b.v.endereco);
    let id: number;
    if (existente) {
      await atualizarCaixa(sql, d.masterKey, existente.id, { senha: b.v.senha, ...(b.v.nome_exibicao ? { nome_exibicao: b.v.nome_exibicao } : {}) });
      id = existente.id;
    } else {
      const cx = await criarCaixa(sql, d.masterKey, { endereco: b.v.endereco, senha: b.v.senha, nome_exibicao: b.v.nome_exibicao });
      id = cx.id;
    }
    const teste = await testarEGravar(id, b.v.endereco, b.v.senha);
    sincronizar(id);
    return c.json({ caixa: await obterCaixa(sql, id), teste });
  });

  app.post("/importar-poste", json, async (c) => {
    const cfg = configPosteAdmin(d.mail.imapHost);
    if (!cfg) {
      return c.json({ erro: "Defina POSTE_ADMIN_USUARIO e POSTE_ADMIN_SENHA no app do Correio" }, 503);
    }
    const b = await corpo(c, z.object({ senha: Senha.optional() }));
    if (!b.ok) return b.r;
    const senha = b.v.senha ?? cfg.senhaCaixas;
    if (!senha) {
      return c.json({ erro: "Informe a senha das caixas (ou defina POSTE_SENHA_CAIXAS)" }, 400);
    }
    let doPoste;
    try {
      doPoste = await listarCaixasPoste(cfg);
    } catch (e) {
      if (e instanceof ErroPosteAdmin) {
        return c.json({ erro: e.message }, e.status === 401 ? 401 : 502);
      }
      throw e;
    }
    const ja = new Set((await listarCaixas(sql)).map((x) => x.endereco));
    const resultado: { endereco: string; estado: string; detalhe?: string }[] = [];
    let recusasSeguidas = 0;
    let ordem = ja.size;
    for (const p of doPoste) {
      if (ja.has(p.endereco)) {
        resultado.push({ endereco: p.endereco, estado: "ja_existia" });
        continue;
      }
      if (p.desativada) {
        resultado.push({ endereco: p.endereco, estado: "desativada_no_poste" });
        continue;
      }
      if (recusasSeguidas >= 3) {
        resultado.push({ endereco: p.endereco, estado: "nao_tentada", detalhe: "parei após 3 senhas recusadas seguidas" });
        continue;
      }
      let caixa;
      try {
        caixa = await criarCaixa(sql, d.masterKey, {
          endereco: p.endereco,
          senha,
          nome_exibicao: p.nome || undefined,
          ordem: ordem++,
        });
      } catch (e) {
        if (e instanceof EnderecoDuplicado) {
          resultado.push({ endereco: p.endereco, estado: "ja_existia" });
          continue;
        }
        throw e;
      }
      const teste = await testarEGravar(caixa.id, caixa.endereco, senha);
      if (teste.falhaAutenticacao || !teste.imap) {
        // não deixa caixa quebrada na lista: remove e informa
        await removerCaixa(sql, caixa.id);
        recusasSeguidas += teste.falhaAutenticacao ? 1 : 0;
        resultado.push({
          endereco: p.endereco,
          estado: teste.falhaAutenticacao ? "senha_diferente" : "erro",
          detalhe: teste.erro,
        });
        continue;
      }
      recusasSeguidas = 0;
      await auditarSemFalhar(sql, "caixa_importada_poste", caixa.endereco);
      sincronizar(caixa.id);
      resultado.push({
        endereco: p.endereco,
        estado: "importada",
        detalhe: teste.smtp ? `envio via ${teste.envioVia ?? "poste.io"}` : `IMAP ok; SMTP: ${teste.erro ?? "falhou"}`,
      });
    }
    return c.json({
      total: doPoste.length,
      importadas: resultado.filter((r) => r.estado === "importada").length,
      resultado,
    });
  });

  app.post("/", json, async (c) => {
    const b = await corpo(c, Nova);
    if (!b.ok) return b.r;
    let caixa;
    try {
      caixa = await criarCaixa(sql, d.masterKey, b.v);
    } catch (e) {
      if (e instanceof EnderecoDuplicado) {
        return c.json({ erro: e.message }, 409);
      }
      throw e;
    }
    await auditarSemFalhar(sql, "caixa_criada", caixa.endereco);
    const teste = await testarEGravar(caixa.id, caixa.endereco, b.v.senha);
    sincronizar(caixa.id);
    return c.json({ caixa: await obterCaixa(sql, caixa.id), teste }, 201);
  });

  app.patch("/:id", json, async (c) => {
    const id = idDe(c);
    if (id === null) return naoEncontrada(c);
    const b = await corpo(c, Alteracao);
    if (!b.ok) return b.r;
    const caixa = await atualizarCaixa(sql, d.masterKey, id, b.v);
    if (!caixa) return naoEncontrada(c);
    if (b.v.senha === undefined) {
      sincronizar(id);
      return c.json({ caixa });
    }
    await auditarSemFalhar(sql, "caixa_senha_alterada", caixa.endereco);
    const teste = await testarEGravar(id, caixa.endereco, b.v.senha);
    sincronizar(id);
    return c.json({ caixa: await obterCaixa(sql, id), teste });
  });

  app.delete("/:id", json, async (c) => {
    const id = idDe(c);
    const caixa = id === null ? null : await obterCaixa(sql, id);
    if (!caixa || !(await removerCaixa(sql, caixa.id))) {
      return naoEncontrada(c);
    }
    await auditarSemFalhar(sql, "caixa_removida", caixa.endereco);
    sincronizar(caixa.id);
    return c.json({ ok: true });
  });

  app.post("/:id/testar", json, async (c) => {
    const id = idDe(c);
    let cred;
    try {
      cred = id === null ? null : await lerSenha(sql, d.masterKey, id);
    } catch (e) {
      if (!(e instanceof SenhaIlegivel)) throw e;
      if (id !== null) sincronizar(id);
      return c.json({
        erro: MENSAGEM_SENHA_ILEGIVEL,
        precisaSenha: true,
      }, 409);
    }
    if (id === null || !cred) return naoEncontrada(c);
    const teste = await testarEGravar(id, cred.endereco, cred.senha);
    sincronizar(id);
    return c.json({ caixa: await obterCaixa(sql, id), teste });
  });

  for (const tipo of ["logo", "favicon"] as TipoImagem[]) {
    app.put(
      `/:id/${tipo}`,
      limiteCorpo(LIMITES[tipo] + FOLGA_MULTIPART, MENSAGEM[tipo]),
      async (c) => {
        const id = idDe(c);
        if (id === null) return naoEncontrada(c);
        const bytes = await lerUpload(c);
        if (bytes === null) {
          return c.json({ erro: `Envie o arquivo. ${MENSAGEM[tipo]}` }, 400);
        }
        if (bytes.length > LIMITES[tipo]) {
          return c.json({ erro: MENSAGEM[tipo] }, 413);
        }
        const v = validarImagem(bytes, tipo);
        if (!v.ok) return c.json({ erro: v.motivo }, 400);
        if (!(await salvarImagem(sql, id, tipo, bytes, v.mime))) {
          return naoEncontrada(c);
        }
        return c.json({ caixa: await obterCaixa(sql, id) });
      },
    );
  }

  app.put("/:id/assinatura", json, async (c) => {
    const id = idDe(c);
    if (id === null) return naoEncontrada(c);
    const b = await corpo(c, Assinatura);
    if (!b.ok) return b.r;
    if (!(await salvarAssinatura(sql, id, b.v))) return naoEncontrada(c);
    const caixa = await obterCaixa(sql, id);
    const previa = gerarAssinatura(b.v, {
      logoCid: caixa?.tem_logo ? CID_LOGO : undefined,
    });
    return c.json({ assinatura: b.v, previa });
  });

  return app;
}

/** Corpo bruto, ou o primeiro arquivo de um multipart; null se vazio. */
export async function lerUpload(c: Context): Promise<Uint8Array | null> {
  const ct = (c.req.header("Content-Type") ?? "").toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      return null;
    }
    const arq = Object.values(form).flat().find((v) => v instanceof File) as
      | File
      | undefined;
    if (!arq || arq.size === 0) return null;
    return new Uint8Array(await arq.arrayBuffer());
  }
  const b = new Uint8Array(await c.req.arrayBuffer());
  return b.length ? b : null;
}

/** /api/marca/:id/logo|favicon — imagens da caixa (exige sessão). */
export function rotasMarca(sql: Sql): Hono {
  const app = new Hono();
  for (const tipo of ["logo", "favicon"] as TipoImagem[]) {
    app.get(`/:id/${tipo}`, async (c) => {
      const id = idDe(c);
      const img = id === null ? null : await lerImagem(sql, id, tipo);
      if (!img) return c.json({ erro: "Imagem não encontrada" }, 404);
      return c.body(img.bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": img.mime,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      });
    });
  }
  return app;
}
