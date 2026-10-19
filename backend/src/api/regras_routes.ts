// /api/caixas/:id/regras — encaminhamento automático e resposta automática
// por Sieve (ManageSieve, porta 4190). O Correio é dono do script
// "correio"; outro script ativo só é substituído com {substituir:true}.
import { Hono } from "@hono/hono";
import { z } from "zod";
import type { Sql } from "../db/client.ts";
import { auditar } from "../db/auditoria.ts";
import { lerSenha, obterCaixa, SenhaIlegivel } from "../caixas/repo.ts";
import {
  type ConfigMail,
  ehFalhaAutenticacao,
  resumirErroMail,
} from "../mail/conexao.ts";
import {
  CaixaNaoEncontrada,
  CaixaPrecisaSenha,
  MENSAGEM_SENHA_ILEGIVEL,
} from "../mail/pool.ts";
import {
  abrirSieve as abrirSievePadrao,
  type Capacidades,
  type ClienteSieve,
  type ConfigSieve,
  configSieve,
  FalhaProtocoloSieve,
  RecusaSieve,
} from "../mail/sieve.ts";
import {
  emailValido,
  gerarScript,
  lerDadosScript,
  MAX_REDIRECTS_PADRAO,
  NOME_SCRIPT,
  type Regras,
  regrasPadrao,
} from "../mail/regras_sieve.ts";
import { comCaixa, Invalido } from "./erros.ts";
import { corpo, limiteCorpo } from "./util.ts";
import type { Registrador } from "../db/registro.ts";

export interface RegrasDeps {
  sql: Sql;
  masterKey: Uint8Array;
  mail: ConfigMail & Partial<ConfigSieve>;
  /** Injetável nos testes; padrão: abrirSieve real. */
  abrirSieve?: typeof abrirSievePadrao;
  /** Logger de atividade/erro (tabela correio.registro); ausente → não registra. */
  registro?: Registrador;
  timeoutMs?: number;
}

/** ManageSieve inalcançável (rede, TLS, senha recusada, protocolo). */
class SieveIndisponivel extends Error {}

/** AAAA-MM-DD que existe no calendário (2026-02-30 não; o Date rolaria). */
export function dataDeCalendario(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const Data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD")
  .refine(dataDeCalendario, "Data inválida");

const Corpo = z.object({
  encaminhar: z.object({
    ativo: z.boolean(),
    para: z.array(z.string().trim().max(254)).max(20).default([]),
    manterCopia: z.boolean().default(true),
  }).strict(),
  ferias: z.object({
    ativo: z.boolean(),
    assunto: z.string().max(200).default(""),
    mensagem: z.string().max(10_000).default(""),
    inicio: Data.nullable().optional(),
    fim: Data.nullable().optional(),
    dias: z.number().int().min(1).max(30).default(1),
  }).strict(),
  substituir: z.boolean().optional(),
}).strict();

function recursos(c: Capacidades) {
  return {
    ferias: c.extensoes.has("vacation"),
    datas: c.extensoes.has("date") && c.extensoes.has("relational"),
    copia: c.extensoes.has("copy"),
    maxEncaminhamentos: c.maxRedirects ?? MAX_REDIRECTS_PADRAO,
  };
}

function motivo(e: unknown, porta: number): string {
  if (ehFalhaAutenticacao(e)) {
    return "O servidor recusou a senha desta caixa no ManageSieve (filtros).";
  }
  if (e instanceof FalhaProtocoloSieve) {
    return `O serviço de filtros (ManageSieve, porta ${porta}) respondeu de forma inesperada: ${e.message}.`;
  }
  return `Não foi possível conectar ao serviço de filtros (ManageSieve, porta ${porta}) do servidor: ${
    resumirErroMail(e)
  }. Encaminhamento e resposta automática ficam indisponíveis.`;
}

/** Saída pública: inicio/fim só quando existem. */
function publicas(r: Regras) {
  const { inicio, fim, ...f } = r.ferias;
  return {
    encaminhar: r.encaminhar,
    ferias: { ...f, ...(inicio ? { inicio } : {}), ...(fim ? { fim } : {}) },
  };
}

export function rotasRegras(d: RegrasDeps): Hono {
  const app = new Hono();
  const cfg = configSieve(d.mail);
  const abrir = d.abrirSieve ?? abrirSievePadrao;

  /** Conecta (caixa precisa existir e ter senha) e roda fn; sempre sai. */
  async function comSieve<T>(
    id: number,
    fn: (s: ClienteSieve, endereco: string) => Promise<T>,
  ): Promise<T> {
    const caixa = await obterCaixa(d.sql, id);
    if (!caixa) throw new CaixaNaoEncontrada();
    if (caixa.estado === "precisa_senha") {
      throw new CaixaPrecisaSenha(
        caixa.estado_motivo ? MENSAGEM_SENHA_ILEGIVEL : undefined,
      );
    }
    let cred;
    try {
      cred = await lerSenha(d.sql, d.masterKey, id);
    } catch (e) {
      if (e instanceof SenhaIlegivel) {
        throw new CaixaPrecisaSenha(MENSAGEM_SENHA_ILEGIVEL);
      }
      throw e;
    }
    if (!cred) throw new CaixaNaoEncontrada();
    let s: ClienteSieve;
    try {
      s = await abrir(cfg, { endereco: cred.endereco }, cred.senha, {
        timeoutMs: d.timeoutMs ?? 15_000,
      });
    } catch (e) {
      console.error(
        "[regras] ManageSieve indisponível:",
        (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
      );
      throw new SieveIndisponivel(motivo(e, cfg.sievePort));
    }
    try {
      return await fn(s, cred.endereco);
    } catch (e) {
      if (e instanceof RecusaSieve || e instanceof Invalido) throw e;
      console.error(
        "[regras] falha no ManageSieve:",
        (e as { code?: string })?.code ?? (e as Error)?.name ?? "erro",
      );
      throw new SieveIndisponivel(motivo(e, cfg.sievePort));
    } finally {
      await s.sair();
    }
  }

  async function estado(s: ClienteSieve) {
    const scripts = await s.listar();
    const ativo = scripts.find((x) => x.ativo)?.nome ?? null;
    const existe = scripts.some((x) => x.nome === NOME_SCRIPT);
    const texto = existe ? await s.ler(NOME_SCRIPT) : null;
    const regras = (texto && lerDadosScript(texto)) || regrasPadrao();
    return { ativo, regras };
  }

  app.get(
    "/:id/regras",
    comCaixa("regras", async (c, id) => {
      try {
        return await comSieve(id, async (s) => {
          const { ativo, regras } = await estado(s);
          return c.json({
            ...publicas(regras),
            ...(ativo && ativo !== NOME_SCRIPT
              ? { outroScriptAtivo: ativo }
              : {}),
            suportado: true,
            recursos: recursos(s.capacidades),
          });
        });
      } catch (e) {
        if (!(e instanceof SieveIndisponivel)) throw e;
        return c.json({
          ...publicas(regrasPadrao()),
          suportado: false,
          motivo: e.message,
        });
      }
    }),
  );

  app.put(
    "/:id/regras",
    limiteCorpo(),
    comCaixa("regras", async (c, id) => {
      const b = await corpo(c, Corpo);
      if (!b.ok) return b.r;
      const v = b.v;
      const para: string[] = [];
      for (const p of v.encaminhar.para) {
        const e = p.toLowerCase();
        if (!emailValido(e)) {
          throw new Invalido(`Endereço inválido: ${p.slice(0, 100)}`);
        }
        if (!para.includes(e)) para.push(e);
      }
      if (v.encaminhar.ativo && !para.length) {
        throw new Invalido("Informe ao menos um endereço para encaminhar");
      }
      if (v.ferias.ativo && !v.ferias.mensagem.trim()) {
        throw new Invalido("Escreva a mensagem da resposta automática");
      }
      if (v.ferias.inicio && v.ferias.fim && v.ferias.inicio > v.ferias.fim) {
        throw new Invalido("A data de início deve ser antes do fim");
      }
      const regras: Regras = {
        encaminhar: {
          ativo: v.encaminhar.ativo,
          para,
          manterCopia: v.encaminhar.manterCopia,
        },
        ferias: {
          ativo: v.ferias.ativo,
          assunto: v.ferias.assunto,
          mensagem: v.ferias.mensagem,
          ...(v.ferias.inicio ? { inicio: v.ferias.inicio } : {}),
          ...(v.ferias.fim ? { fim: v.ferias.fim } : {}),
          dias: v.ferias.dias,
        },
      };

      try {
        return await comSieve(id, async (s, endereco) => {
          if (para.includes(endereco.toLowerCase())) {
            throw new Invalido("Não encaminhe a caixa para ela mesma");
          }
          const rec = recursos(s.capacidades);
          if (regras.encaminhar.ativo && para.length > rec.maxEncaminhamentos) {
            throw new Invalido(
              `O servidor aceita no máximo ${rec.maxEncaminhamentos} endereços de encaminhamento`,
            );
          }
          if (regras.ferias.ativo && !rec.ferias) {
            return c.json({
              erro:
                "O servidor não oferece resposta automática (extensão vacation do Sieve).",
            }, 422);
          }
          const scripts = await s.listar();
          const ativo = scripts.find((x) => x.ativo)?.nome ?? null;
          const outro = ativo && ativo !== NOME_SCRIPT ? ativo : null;
          const g = gerarScript(regras, {
            extensoes: s.capacidades.extensoes,
            endereco,
          });
          if (outro && g.temRegra && !v.substituir) {
            return c.json({
              erro:
                `Já existe outro filtro ativo no servidor ("${outro}"). Confirme para substituí-lo pelo do Correio.`,
              outroScriptAtivo: outro,
            }, 409);
          }
          try {
            await s.gravar(NOME_SCRIPT, g.script);
          } catch (e) {
            if (!(e instanceof RecusaSieve)) throw e;
            return c.json({
              erro: `O servidor recusou o filtro: ${
                // deno-lint-ignore no-control-regex
                e.texto.replace(/[\x00-\x1f\x7f]+/g, " ").slice(0, 300) ||
                "sem detalhes"}`,
            }, 422);
          }
          if (g.temRegra) {
            if (ativo !== NOME_SCRIPT) await s.ativar(NOME_SCRIPT);
          } else if (ativo === NOME_SCRIPT) {
            await s.ativar(""); // nada ligado: desativa sem apagar o formulário
          }
          try {
            await auditar(d.sql, "usuario", "regras_alteradas", endereco, {
              encaminhar: regras.encaminhar.ativo ? para.length : 0,
              ferias: regras.ferias.ativo,
              substituiu: g.temRegra && outro ? outro : null,
            });
          } catch (e) {
            console.error("[regras] falha ao auditar:", (e as Error)?.name);
          }
          void d.registro?.registrar({
            nivel: "info",
            area: "sieve",
            caixaId: id,
            mensagem: `Filtro Sieve aplicado em ${endereco}`,
            detalhe: {
              encaminhar: regras.encaminhar.ativo ? para.length : 0,
              ferias: regras.ferias.ativo,
            },
          });
          const restante = g.temRegra ? null : outro;
          return c.json({
            ok: true,
            ...publicas(regras),
            ...(restante ? { outroScriptAtivo: restante } : {}),
            suportado: true,
            recursos: rec,
            ...(g.avisos.length ? { avisos: g.avisos } : {}),
          });
        });
      } catch (e) {
        if (!(e instanceof SieveIndisponivel)) throw e;
        return c.json({ erro: e.message, suportado: false }, 503);
      }
    }),
  );

  return app;
}
