// /api/resend — mapeamento domínio→slot da Resend (sessão + CSRF em criarApp).
// As CHAVES ficam só no ambiente; aqui nunca entram nem saem. Listagens trazem
// só a máscara (re_7v…MPr), lida do ambiente.
import { type Context, Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import { corpo, limiteCorpo } from "./util.ts";
import {
  abrirSmtp,
  type ConfigMail,
  resumirErroMail,
} from "../mail/conexao.ts";
import {
  alvoSmtp,
  contaDeSlot,
  mascararChave,
  MAX_SLOTS,
  type ResendConfig,
} from "../mail/resend.ts";
import {
  atribuirDominio,
  ChaveSlotAusente,
  listarSlots,
  removerDominio,
  renomearSlot,
  SlotInvalido,
} from "../mail/resend_contas.ts";
import { ConfigError } from "../config.ts";

/** verify() do SMTP da Resend com a chave do slot; lança em falha. */
export type VerificarResend = (
  cfg: ConfigMail,
  usuario: string,
  senha: string,
) => Promise<void>;

export interface ResendDeps {
  sql: Sql;
  mail: ConfigMail;
  /** Chaves da Resend do ambiente (RESEND_CONTA_1..20). */
  resend?: ResendConfig;
  /** Injetável nos testes; padrão: abrirSmtp real + verify(). */
  verificar?: VerificarResend;
}

const AtribuirDom = z.object({
  slot: z.number().int().min(1).max(MAX_SLOTS),
  dominio: z.string().trim().min(1).max(253),
}).strict();

const RemoverDom = z.object({
  dominio: z.string().trim().min(1).max(253),
}).strict();

const Nome = z.object({ nome: z.string().trim().max(100) }).strict();

function slotDe(c: Context): number | null {
  const p = c.req.param("n") ?? "";
  if (!/^\d{1,3}$/.test(p)) return null;
  const n = Number(p);
  return n >= 1 && n <= MAX_SLOTS ? n : null;
}

function erroMapa(c: Context, e: unknown): Response {
  if (e instanceof ChaveSlotAusente || e instanceof ConfigError) {
    return c.json({ erro: e.message }, 400);
  }
  if (e instanceof SlotInvalido) return c.json({ erro: e.message }, 400);
  throw e;
}

async function auditarSeguro(sql: Sql, acao: string, alvo: string | null) {
  try {
    await auditar(sql, "usuario", acao, alvo);
  } catch (e) {
    console.error(`[resend] falha ao auditar ${acao}:`, (e as Error)?.name);
  }
}

export function rotasResend(d: ResendDeps): Hono {
  const { sql } = d;
  const app = new Hono();
  app.use("*", limiteCorpo());

  const verificar: VerificarResend = d.verificar ?? (async (cfg, u, s) => {
    const t = abrirSmtp(cfg, { endereco: u }, s, { timeoutMs: 20_000 });
    try {
      await t.verify();
    } finally {
      t.close();
    }
  });

  app.get(
    "/",
    async (c) => c.json({ slots: await listarSlots(sql, d.resend) }),
  );

  app.post("/dominio", async (c) => {
    const b = await corpo(c, AtribuirDom);
    if (!b.ok) return b.r;
    try {
      await atribuirDominio(sql, d.resend, b.v.slot, b.v.dominio);
      await auditarSeguro(sql, "resend_dominio_atribuido", b.v.dominio);
      return c.json({ slots: await listarSlots(sql, d.resend) });
    } catch (e) {
      return erroMapa(c, e);
    }
  });

  app.delete("/dominio", async (c) => {
    const b = await corpo(c, RemoverDom);
    if (!b.ok) return b.r;
    const ok = await removerDominio(sql, b.v.dominio);
    if (ok) await auditarSeguro(sql, "resend_dominio_removido", b.v.dominio);
    return c.json({ ok, slots: await listarSlots(sql, d.resend) });
  });

  app.patch("/slot/:n", async (c) => {
    const n = slotDe(c);
    if (n === null) return c.json({ erro: "Slot inválido" }, 404);
    const b = await corpo(c, Nome);
    if (!b.ok) return b.r;
    try {
      await renomearSlot(sql, n, b.v.nome);
      await auditarSeguro(sql, "resend_slot_renomeado", String(n));
      return c.json({ slots: await listarSlots(sql, d.resend) });
    } catch (e) {
      return erroMapa(c, e);
    }
  });

  app.post("/slot/:n/testar", async (c) => {
    const n = slotDe(c);
    if (n === null) return c.json({ erro: "Slot inválido" }, 404);
    const s = d.resend?.slots.get(n);
    if (!s) {
      return c.json({
        ok: false,
        erro: `O slot ${n} não tem chave no ambiente (RESEND_CONTA_${n}).`,
      }, 400);
    }
    const alvo = alvoSmtp(
      {
        tipo: "resend",
        conta: contaDeSlot(s.apikey),
        mascara: mascararChave(s.apikey),
        slot: n,
      },
      d.mail,
      "",
      "",
    );
    try {
      await verificar(alvo.cfg, alvo.usuario, alvo.senha);
      return c.json({ ok: true, via: alvo.descricao });
    } catch (e) {
      console.error(
        "[resend] teste falhou:",
        (e as { code?: string })?.code ?? (e as Error)?.name,
      );
      return c.json({
        ok: false,
        via: alvo.descricao,
        erro: resumirErroMail(e),
      });
    }
  });

  return app;
}
