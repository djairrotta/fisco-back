// Estúdio de assinatura (2.0): /api/caixas/:id/assinaturas…
//   GET    /                  → {assinaturas, padroes, avisoPadrao}
//   POST   /                  {nome, modelo, campos} → 201 {assinatura}
//   PUT    /padroes           {nova, resposta} (ids ou null)
//   POST   /previa            {modelo, campos, assinaturaId?} → {html, texto}
//   GET    /:aid              → {assinatura, previa}
//   PATCH  /:aid              {nome?, modelo?, campos?}
//   DELETE /:aid
//   GET    /:aid/html         → download .html (imagens embutidas)
//   PUT    /:aid/logo         logo próprio (PNG/JPEG/WebP, até 2 MB)
//   GET    /:aid/logo, DELETE /:aid/logo
import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { corpo, limiteCorpo } from "./util.ts";
import { idCaixa } from "./erros.ts";
import { obterCaixa } from "../caixas/repo.ts";
import {
  atualizarAssinatura,
  criarAssinatura,
  definirPadroes,
  gerarSalva,
  lerLogoAssinatura,
  lerPadroes,
  LimiteAssinaturas,
  listarAssinaturas,
  logoDaAssinatura,
  obterAssinatura,
  removerAssinatura,
  salvarLogoAssinatura,
} from "../caixas/assinaturas_repo.ts";
import {
  AVISO_PADRAO,
  DIVISORES,
  documentoAssinatura,
  emailSeguro,
  gerarAssinaturaModelo,
  MODELOS,
  NOMES_MODELO,
  ORIGENS_LOGO,
  REDES,
  urlSegura,
} from "../caixas/modelos_assinatura.ts";
import { LIMITES, MENSAGEM, validarImagem } from "../caixas/marca.ts";
import { lerUpload } from "./caixas_routes.ts";

/** Limites dos campos de texto (o schema e a normalização usam os mesmos). */
export const LIMITES_CAMPOS = {
  nome: 120,
  cargo: 120,
  empresa: 160,
  registro: 120,
  telefone: 40,
  whatsapp: 40,
  endereco: 300,
} as const;
const LIMITE_URL = 300;
const LIMITE_AVISO = 3000;

const T = (max: number) => z.string().trim().max(max);
const Url = T(LIMITE_URL).refine((s) => s === "" || urlSegura(s) !== null, {
  message: "Use um endereço http(s) válido",
});

export const CamposSchema = z.object({
  nome: T(LIMITES_CAMPOS.nome).optional(),
  cargo: T(LIMITES_CAMPOS.cargo).optional(),
  empresa: T(LIMITES_CAMPOS.empresa).optional(),
  registro: T(LIMITES_CAMPOS.registro).optional(),
  telefone: T(LIMITES_CAMPOS.telefone).optional(),
  whatsapp: T(LIMITES_CAMPOS.whatsapp).optional(),
  email: T(254).refine((s) => s === "" || emailSeguro(s) !== null, {
    message: "E-mail inválido",
  }).optional(),
  site: Url.optional(),
  endereco: T(LIMITES_CAMPOS.endereco).optional(),
  redes: z.object(
    Object.fromEntries(REDES.map((r) => [r, Url.optional()])) as Record<
      typeof REDES[number],
      z.ZodOptional<typeof Url>
    >,
  ).strict().optional(),
  aviso: z.string().max(LIMITE_AVISO).optional(),
  logo: z.enum(ORIGENS_LOGO).optional(),
  corDestaque: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor deve ser #rrggbb")
    .transform((s) => s.toLowerCase()).optional(),
  divisor: z.enum(DIVISORES).optional(),
}).strict();

type Campos = Record<string, unknown>;

const urlCabe = (v: unknown) =>
  typeof v === "string" && v.trim().length <= LIMITE_URL &&
  urlSegura(v) !== null;

/**
 * Leva campos GUARDADOS aos limites atuais: corta textos, tira site/redes
 * que não são http(s), e-mail, cor ou opções inválidos. Usado no PATCH só
 * para os valores que o cliente devolveu iguais ao que estava guardado.
 */
export function normalizarCampos(c: Campos): Campos {
  const out: Campos = { ...c };
  for (const [k, n] of Object.entries(LIMITES_CAMPOS)) {
    const v = out[k];
    if (typeof v === "string") out[k] = v.trim().slice(0, n);
    else if (v !== undefined) delete out[k];
  }
  if (out.site !== undefined && out.site !== "" && !urlCabe(out.site)) {
    delete out.site;
  }
  if (
    out.email !== undefined && out.email !== "" &&
    (typeof out.email !== "string" || emailSeguro(out.email) === null)
  ) delete out.email;
  if (typeof out.aviso === "string") {
    out.aviso = out.aviso.slice(0, LIMITE_AVISO);
  } else if (out.aviso !== undefined) delete out.aviso;
  if (out.redes !== undefined) {
    const r: Campos = {};
    if (out.redes && typeof out.redes === "object") {
      for (const rede of REDES) {
        const v = (out.redes as Campos)[rede];
        if (v === "" || urlCabe(v)) r[rede] = v;
      }
    }
    if (Object.keys(r).length) out.redes = r;
    else delete out.redes;
  }
  if (
    out.corDestaque !== undefined &&
    !(typeof out.corDestaque === "string" &&
      /^#[0-9a-fA-F]{6}$/.test(out.corDestaque))
  ) delete out.corDestaque;
  if (
    out.logo !== undefined &&
    !(ORIGENS_LOGO as readonly unknown[]).includes(out.logo)
  ) delete out.logo;
  if (
    out.divisor !== undefined &&
    !(DIVISORES as readonly unknown[]).includes(out.divisor)
  ) delete out.divisor;
  return out;
}

const igual = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Valores do pedido iguais aos guardados passam pela normalização (dados
 * antigos fora dos limites não travam a edição); valores novos seguem
 * para a validação normal.
 */
export function tolerarGuardados(pedido: Campos, guardado: Campos): Campos {
  const norm = normalizarCampos(guardado);
  const out: Campos = { ...pedido };
  for (const k of Object.keys(pedido)) {
    if (k === "redes" && pedido.redes && typeof pedido.redes === "object") {
      const g = (guardado.redes ?? {}) as Campos;
      const n = (norm.redes ?? {}) as Campos;
      const r: Campos = { ...(pedido.redes as Campos) };
      for (const rede of Object.keys(r)) {
        if (igual(r[rede], g[rede])) {
          if (rede in n) r[rede] = n[rede];
          else delete r[rede];
        }
      }
      out.redes = r;
    } else if (igual(pedido[k], guardado[k])) {
      if (k in norm) out[k] = norm[k];
      else delete out[k];
    }
  }
  return out;
}

const Nome = z.string().trim().min(1).max(100);
const Modelo = z.enum(MODELOS);

const Nova = z.object({
  nome: Nome.optional(),
  modelo: Modelo.default("classico"),
  campos: CamposSchema.default({}),
}).strict();

const Alteracao = z.object({
  nome: Nome.optional(),
  modelo: Modelo.optional(),
  campos: CamposSchema.optional(),
}).strict();

const IdOuNull = z.number().int().min(1).max(999_999_999).nullable();
const PadroesSchema = z.object({ nova: IdOuNull, resposta: IdOuNull }).strict();

const Previa = z.object({
  modelo: Modelo.default("classico"),
  campos: CamposSchema.default({}),
  /** Para usar o logo próprio já enviado de uma assinatura salva. */
  assinaturaId: z.number().int().min(1).max(999_999_999).optional(),
}).strict();

const FOLGA_MULTIPART = 64 * 1024;

const caixaNaoEncontrada = (c: Context) =>
  c.json({ erro: "Caixa não encontrada" }, 404);
const naoEncontrada = (c: Context) =>
  c.json({ erro: "Assinatura não encontrada" }, 404);

function aidDe(c: Context): number | null {
  const p = c.req.param("aid") ?? "";
  return /^\d{1,9}$/.test(p) ? Number(p) : null;
}

/** "Djair — Clássico" → "djair-classico" (nome do arquivo baixado). */
function slug(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) ||
    "assinatura";
}

export function rotasAssinaturas(d: { sql: Sql }): Hono {
  const { sql } = d;
  const app = new Hono();
  const json = limiteCorpo();
  const base = "/:id/assinaturas";

  app.get(base, async (c) => {
    const id = idCaixa(c);
    const padroes = id === null ? null : await lerPadroes(sql, id);
    if (id === null || !padroes) return caixaNaoEncontrada(c);
    return c.json({
      assinaturas: await listarAssinaturas(sql, id),
      padroes,
      avisoPadrao: AVISO_PADRAO,
      modelos: MODELOS.map((m) => ({ id: m, nome: NOMES_MODELO[m] })),
    });
  });

  app.post(base, json, async (c) => {
    const id = idCaixa(c);
    if (id === null) return caixaNaoEncontrada(c);
    const b = await corpo(c, Nova);
    if (!b.ok) return b.r;
    const campos = { ...b.v.campos };
    if (campos.aviso === undefined) campos.aviso = AVISO_PADRAO;
    try {
      const a = await criarAssinatura(sql, id, {
        nome: b.v.nome ?? NOMES_MODELO[b.v.modelo],
        modelo: b.v.modelo,
        campos,
      });
      if (!a) return caixaNaoEncontrada(c);
      return c.json({ assinatura: a }, 201);
    } catch (e) {
      if (e instanceof LimiteAssinaturas) {
        return c.json({ erro: e.message }, 409);
      }
      throw e;
    }
  });

  app.put(`${base}/padroes`, json, async (c) => {
    const id = idCaixa(c);
    if (id === null) return caixaNaoEncontrada(c);
    const b = await corpo(c, PadroesSchema);
    if (!b.ok) return b.r;
    const r = await definirPadroes(sql, id, b.v);
    if (r === "caixa") return caixaNaoEncontrada(c);
    if (r === "invalida") {
      return c.json({ erro: "Assinatura não encontrada nesta caixa" }, 400);
    }
    return c.json({ ok: true, padroes: b.v });
  });

  app.post(`${base}/previa`, json, async (c) => {
    const id = idCaixa(c);
    const caixa = id === null ? null : await obterCaixa(sql, id);
    if (!caixa) return caixaNaoEncontrada(c);
    const b = await corpo(c, Previa);
    if (!b.ok) return b.r;
    if (
      b.v.assinaturaId !== undefined &&
      !(await obterAssinatura(sql, caixa.id, b.v.assinaturaId))
    ) return naoEncontrada(c);
    const logo = await logoDaAssinatura(
      sql,
      caixa,
      b.v.campos,
      b.v.assinaturaId ?? null,
    );
    const g = gerarAssinaturaModelo(b.v.modelo, b.v.campos, {
      logo,
      imagens: "dataUri",
      corPadrao: caixa.cor,
    });
    return c.json({ html: g.html, texto: g.texto });
  });

  app.get(`${base}/:aid`, async (c) => {
    const id = idCaixa(c);
    const aid = aidDe(c);
    const caixa = id === null ? null : await obterCaixa(sql, id);
    if (!caixa) return caixaNaoEncontrada(c);
    const a = aid === null ? null : await obterAssinatura(sql, caixa.id, aid);
    if (!a) return naoEncontrada(c);
    const g = await gerarSalva(sql, caixa, a, "dataUri");
    return c.json({ assinatura: a, previa: { html: g.html, texto: g.texto } });
  });

  app.patch(`${base}/:aid`, json, async (c) => {
    const id = idCaixa(c);
    const aid = aidDe(c);
    if (id === null) return caixaNaoEncontrada(c);
    if (aid === null) return naoEncontrada(c);
    const atual = await obterAssinatura(sql, id, aid);
    if (!atual) return naoEncontrada(c);
    let bruto: unknown;
    try {
      bruto = JSON.parse((await c.req.text()) || "{}");
    } catch {
      return c.json({ erro: "JSON inválido" }, 400);
    }
    if (
      bruto && typeof bruto === "object" && !Array.isArray(bruto) &&
      (bruto as Campos).campos && typeof (bruto as Campos).campos === "object"
    ) {
      (bruto as Campos).campos = tolerarGuardados(
        (bruto as Campos).campos as Campos,
        atual.campos as Campos,
      );
    }
    const p = Alteracao.safeParse(bruto);
    if (!p.success) {
      return c.json(
        { erro: "Dados inválidos", detalhes: p.error.issues },
        400,
      );
    }
    const a = await atualizarAssinatura(sql, id, aid, p.data);
    if (!a) return naoEncontrada(c);
    return c.json({ assinatura: a });
  });

  app.delete(`${base}/:aid`, json, async (c) => {
    const id = idCaixa(c);
    const aid = aidDe(c);
    if (id === null) return caixaNaoEncontrada(c);
    if (aid === null || !(await removerAssinatura(sql, id, aid))) {
      return naoEncontrada(c);
    }
    return c.json({ ok: true, padroes: await lerPadroes(sql, id) });
  });

  app.get(`${base}/:aid/html`, async (c) => {
    const id = idCaixa(c);
    const aid = aidDe(c);
    const caixa = id === null ? null : await obterCaixa(sql, id);
    if (!caixa) return caixaNaoEncontrada(c);
    const a = aid === null ? null : await obterAssinatura(sql, caixa.id, aid);
    if (!a) return naoEncontrada(c);
    const g = await gerarSalva(sql, caixa, a, "dataUri");
    const nome = `assinatura-${slug(a.nome)}.html`;
    return c.body(documentoAssinatura(a.nome, g.html), 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:",
      "Cache-Control": "no-store",
    });
  });

  app.put(
    `${base}/:aid/logo`,
    limiteCorpo(LIMITES.logo + FOLGA_MULTIPART, MENSAGEM.logo),
    async (c) => {
      const id = idCaixa(c);
      const aid = aidDe(c);
      if (id === null) return caixaNaoEncontrada(c);
      if (aid === null) return naoEncontrada(c);
      const bytes = await lerUpload(c);
      if (bytes === null) {
        return c.json({ erro: `Envie o arquivo. ${MENSAGEM.logo}` }, 400);
      }
      if (bytes.length > LIMITES.logo) {
        return c.json({ erro: MENSAGEM.logo }, 413);
      }
      const v = validarImagem(bytes, "logo");
      if (!v.ok) return c.json({ erro: v.motivo }, 400);
      if (
        !(await salvarLogoAssinatura(sql, id, aid, { bytes, mime: v.mime }))
      ) {
        return naoEncontrada(c);
      }
      return c.json({ assinatura: await obterAssinatura(sql, id, aid) });
    },
  );

  app.get(`${base}/:aid/logo`, async (c) => {
    const id = idCaixa(c);
    const aid = aidDe(c);
    const img = id === null || aid === null
      ? null
      : await lerLogoAssinatura(sql, id, aid);
    if (!img) return c.json({ erro: "Imagem não encontrada" }, 404);
    return c.body(img.bytes as Uint8Array<ArrayBuffer>, 200, {
      "Content-Type": img.mime,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
  });

  app.delete(`${base}/:aid/logo`, json, async (c) => {
    const id = idCaixa(c);
    const aid = aidDe(c);
    if (id === null) return caixaNaoEncontrada(c);
    if (aid === null || !(await salvarLogoAssinatura(sql, id, aid, null))) {
      return naoEncontrada(c);
    }
    return c.json({ assinatura: await obterAssinatura(sql, id, aid) });
  });

  return app;
}
