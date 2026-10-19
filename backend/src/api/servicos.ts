// Lógica das rotas compartilhada entre o PWA (/api/*, sessão de passkey), a
// API v1 (/api/v1/*, token) e o MCP (/mcp, token). Entradas já validadas;
// erros de negócio saem como ErroApi (status HTTP + corpo JSON).
import type { Sql } from "../db/client.ts";
import type { Papel } from "../ai/openrouter.ts";
import { auditar, IpProtegido } from "../monitor/executor.ts";
import { type EstadoIp, estadoIps } from "../monitor/estado_ip.ts";
import { infoBloqueios } from "../monitor/origem_bloqueio.ts";
import { normalizarIp } from "../monitor/grouper.ts";
import { VIGIA_HOST_PADRAO } from "../config.ts";
import {
  configDecisao,
  emObservacao,
  gravarConfig,
  lerConfigGeral,
  limiares,
} from "../scheduler.ts";
import {
  ErroLocalizacao,
  ipPublico,
  localizarIp,
  montarDossie,
  type ProvedorGeoIp,
} from "../ip/localizar.ts";
import {
  ipValido,
  JEV_LIMIAR_MAX,
  JEV_LIMIAR_MIN,
} from "../monitor/decision.ts";
import {
  type ModoProtecao,
  ocorrenciasRecentes,
  protecoesAtuais,
} from "../monitor/protecoes.ts";
import type { Operacoes } from "./routes.ts";
import {
  adicionarHost,
  listarAchados,
  listarHosts,
  normalizarHost,
  removerHost,
  semearHosts,
} from "../auditoria/execucao.ts";
import {
  autorizarCampanha,
  type Campanha,
  cancelarCampanha,
  criarCampanha,
  definirAmbienteHost,
  listarCampanhas,
  rodarCampanha,
  type TipoAtaque,
  verCampanha,
} from "../auditoria/ataque.ts";
import { montarPrompt } from "../auditoria/prompt.ts";
import { listarRevisao } from "../auditoria/revisor.ts";
import { githubZip, listarAchadosCodigo } from "../auditoria/codigo.ts";
import {
  type ModoCabecalhos,
  MODOS_CABECALHOS,
} from "../monitor/cabecalhos.ts";
import {
  listarInstancias as listarSupabaseInstancias,
  listarResultados as listarSupabaseResultados,
  removerInstancia as removerSupabaseInstancia,
  salvarInstancia as salvarSupabaseInstancia,
} from "../auditoria/supabase.ts";
import { estadoEasypanel, listarApps, verApp } from "../easypanel/monitor.ts";
import { criarServidor, ErroSsh } from "../host/servidor.ts";
import { listarIpsServidor } from "../monitor/ip_servidor.ts";
import {
  aplicarDecisaoConector,
  listarPedidos as listarPedidosConector,
  type ModoDecisao as ModoDecisaoConector,
} from "../auditoria/conector.ts";

export class ErroApi extends Error {
  constructor(public status: number, public corpo: Record<string, unknown>) {
    super(String(corpo.erro ?? `HTTP ${status}`));
    this.name = "ErroApi";
  }
}

export interface ServicosDeps {
  sql: Sql;
  agora: () => Date;
  ops: Operacoes;
  geoIp: ProvedorGeoIp;
  vigiaHost?: string;
}

/** Onde configurar o EasyPanel (mostrado quando não está configurado). */
export const INSTRUCOES_EASYPANEL =
  "EasyPanel não configurado. No EasyPanel, crie um token em Settings → API. Depois, no app do Vigia (EasyPanel → projeto → vigia) → Environment, defina EASYPANEL_URL (ex.: https://painel.judinfo.com.br) e EASYPANEL_TOKEN e clique em Deploy.";

const CHAVE_APP = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type Duracao = "24h" | "7d";
export const DIAS_DURACAO: Record<Duracao, number> = { "24h": 1, "7d": 7 };
const OBSERVACAO_SEMPRE = "9999-12-31T23:59:59Z";

const msg = (e: unknown) => (e as Error)?.message ?? String(e);
const mensagemCodigo = (estado: "iniciada" | "ja_rodando") => ({
  mensagem: estado === "iniciada"
    ? "Análise iniciada; leva ~1 minuto. Consulte achados_codigo depois."
    : "Já há uma análise de código em andamento.",
});
export const iso = (d: unknown) =>
  d ? new Date(d as string).toISOString() : null;
const diagnosticoIa = (r: Record<string, unknown>) => ({
  ultimoOkEm: iso(r.ultimo_ok_em),
  ultimoErroEm: iso(r.ultimo_erro_em),
  ultimoErro: (r.ultimo_erro as string | null) ?? null,
});

export type Servicos = ReturnType<typeof criarServicos>;

export function criarServicos(d: ServicosDeps) {
  const { sql, ops } = d;
  const servidor = criarServidor({ sql });

  /** Estado (bloqueio ativo / regra geo) de todos os IPs pedidos, numa consulta. */
  const estados = async (ips: string[]) => {
    const exc =
      await sql`SELECT valor FROM vigia.excecoes WHERE tipo = 'caminho'`;
    const cfg = await lerConfigGeral(sql);
    const desde = cfg.get("geo_ativo_desde");
    return await estadoIps(sql, ips, d.agora(), {
      excecoes: exc.map((r) => String(r.valor)),
      vigiaHost: d.vigiaHost ?? VIGIA_HOST_PADRAO,
      geoAtivoDesde: cfg.get("geo_ativo") === true && typeof desde === "string"
        ? new Date(desde)
        : null,
    });
  };
  // Indexado pelo IP como veio do banco (sem normalizar: evita divergência
  // em IPv4 mapeado em IPv6).
  const estadoDe = (m: Map<string, EstadoIp>, ip: string): EstadoIp =>
    m.get(ip) ??
      { ip, bloqueado: false, bloqueadoAte: null, geo: null, local: null };

  const linhaIncidente = (r: Record<string, unknown>) => ({
    id: Number(r.id),
    chave: r.chave,
    ips: r.ips,
    zonas: r.zonas,
    hosts: r.hosts,
    inicio: iso(r.inicio),
    fim: iso(r.fim),
    classeFinal: r.classe_final,
    status: r.status,
    severidadeMax: r.severidade_max,
    totalSinais: Number(r.total_sinais),
    contagemTotal: Number(r.contagem_total),
    decisao: r.decisao ?? null,
  });

  const lerGeral = async () => {
    const cfg = await lerConfigGeral(sql);
    const ate = cfg.get("modo_observacao_ate");
    return {
      modoObservacao: emObservacao(cfg, d.agora()),
      modoObservacaoAte: typeof ate === "string" ? ate : null,
      geoAtivo: cfg.get("geo_ativo") === true,
      bloqueioAutoAtivo: cfg.get("bloqueio_auto_ativo") === true,
      limiares: limiares(cfg),
      ...configDecisao(cfg),
    };
  };

  const listarAsns = async () => {
    const rows = await sql`
      SELECT asn, nome, ativo FROM vigia.asn_datacenter ORDER BY asn`;
    return rows.map((r) => ({
      asn: Number(r.asn),
      nome: r.nome as string,
      ativo: r.ativo as boolean,
    }));
  };

  const lerIa = async () => {
    const rows = await sql`
      SELECT papel, modelo, timeout_ms, falhas_seguidas, degradado_desde,
        ultimo_ok_em, ultimo_erro_em, ultimo_erro
      FROM vigia.config_ia ORDER BY papel`;
    return rows.map((r) => ({
      papel: r.papel as string,
      modelo: r.modelo as string,
      timeoutMs: r.timeout_ms as number,
      falhasSeguidas: r.falhas_seguidas as number,
      degradado: r.degradado_desde !== null,
      degradadoDesde: iso(r.degradado_desde),
      ...diagnosticoIa(r),
    }));
  };

  /** IP válido e público (privado/reservado nunca vai ao provedor). */
  const ipConsultavel = (ip: string): string => {
    const x = ip.trim();
    if (!ipValido(x)) throw new ErroApi(400, { erro: "IP inválido" });
    if (!ipPublico(x)) {
      throw new ErroApi(400, {
        erro: "IP privado ou reservado: não há localização pública",
      });
    }
    return x;
  };

  const s = {
    estados,
    estadoDe,
    lerGeral,

    // ------------------------------------------------------------ status
    async status() {
      const agora = d.agora();
      const cfg = await lerConfigGeral(sql);
      const falhas = Number(cfg.get("coletor_falhas") ?? 0) || 0;
      const ultimo = typeof cfg.get("coletor_ultimo_ok") === "string"
        ? String(cfg.get("coletor_ultimo_ok"))
        : "";
      const recente = ultimo !== "" &&
        agora.getTime() - new Date(ultimo).getTime() < 5 * 60_000;
      const ciclo = cfg.get("ciclo_ultimo_ok");
      const ias = await sql`
        SELECT papel, modelo, degradado_desde IS NOT NULL AS degradado,
          ultimo_ok_em, ultimo_erro_em, ultimo_erro
        FROM vigia.config_ia WHERE papel <> 'revisor' ORDER BY papel`;
      const [n] = await sql`SELECT
          (SELECT count(*)::int FROM vigia.incidentes
            WHERE fim >= ${new Date(
        agora.getTime() - 86_400_000,
      )}) incidentes_24h,
          (SELECT count(*)::int FROM vigia.bloqueios
            WHERE removido IS NULL) bloqueios_ativos,
          (SELECT count(*)::int FROM vigia.zonas WHERE ativa) zonas`;
      const geral = await lerGeral();
      const prot = await protecoesAtuais(sql);
      return {
        agora: agora.toISOString(),
        coletor: { ok: falhas === 0 && recente, ultimo, falhas },
        cicloUltimoOk: typeof ciclo === "string" ? ciclo : null,
        ias: ias.map((r) => ({
          papel: r.papel,
          modelo: r.modelo,
          degradado: r.degradado,
          ...diagnosticoIa(r),
        })),
        geo: {
          ativo: geral.geoAtivo,
          ativoDesde: typeof cfg.get("geo_ativo_desde") === "string"
            ? cfg.get("geo_ativo_desde")
            : null,
        },
        modoObservacao: geral.modoObservacao,
        modoObservacaoAte: geral.modoObservacaoAte,
        bloqueioAutoAtivo: geral.bloqueioAutoAtivo,
        decisao: {
          jevLimiar: geral.jevLimiar,
          jevExigeSegunda: geral.jevExigeSegunda,
        },
        datacenter: {
          ativo: geral.bloquearDatacenter,
          asns: (await listarAsns()).filter((a) => a.ativo).length,
        },
        protecoes: { modo: prot.modo, rateAtivo: prot.rateAtivo },
        contagens: {
          incidentes24h: Number(n.incidentes_24h),
          bloqueiosAtivos: Number(n.bloqueios_ativos),
          zonas: Number(n.zonas),
        },
      };
    },

    // -------------------------------------------------------- incidentes
    async listarIncidentes(f: { status?: string; limite: number }) {
      const rows = await sql`
        SELECT id, chave, ARRAY(SELECT host(x) FROM unnest(ips) x) ips, zonas, hosts,
          inicio, fim, classe_final, status, severidade_max, total_sinais,
          contagem_total, decisao
        FROM vigia.incidentes
        ${f.status ? sql`WHERE status = ${f.status}` : sql``}
        ORDER BY fim DESC, id DESC LIMIT ${f.limite}`;
      const est = await estados(rows.flatMap((r) => r.ips as string[]));
      return rows.map((r) => ({
        ...linhaIncidente(r),
        estadoIps: (r.ips as string[]).map((ip) => estadoDe(est, ip)),
      }));
    },

    async verIncidente(id: number) {
      const [r] = await sql`
        SELECT id, chave, ARRAY(SELECT host(x) FROM unnest(ips) x) ips, zonas,
          hosts, inicio, fim, sinais, classe_final, status, severidade_max,
          total_sinais, contagem_total, decisao, investigacao, investigado_em
        FROM vigia.incidentes WHERE id = ${id}`;
      if (!r) throw new ErroApi(404, { erro: "Incidente não encontrado" });
      const pareceres = await sql`
        SELECT papel, modelo, classe, confianca::float8 confianca, justificativa,
          latencia_ms, ok
        FROM vigia.pareceres_ia WHERE incidente_id = ${id} ORDER BY id`;
      const bloqueios = await sql`
        SELECT id, host(ip) ip, motivo, criado, expira, removido
        FROM vigia.bloqueios WHERE incidente_id = ${id} ORDER BY id`;
      const est = await estados(r.ips as string[]);
      return {
        ...linhaIncidente(r),
        estadoIps: (r.ips as string[]).map((ip) => estadoDe(est, ip)),
        sinais: r.sinais,
        investigacao: r.investigacao ?? null,
        investigadoEm: iso(r.investigado_em),
        pareceres: pareceres.map((p) => ({
          papel: p.papel,
          modelo: p.modelo,
          classe: p.classe,
          confianca: p.confianca,
          justificativa: p.justificativa,
          latenciaMs: p.latencia_ms,
          ok: p.ok,
        })),
        bloqueios: bloqueios.map((b) => ({
          id: Number(b.id),
          ip: b.ip,
          motivo: b.motivo,
          criado: iso(b.criado),
          expira: iso(b.expira),
          removido: iso(b.removido),
        })),
      };
    },

    async ignorarIncidente(id: number, ator: string) {
      const r = await sql`UPDATE vigia.incidentes SET status = 'ignorado'
        WHERE id = ${id} RETURNING id`;
      if (!r.length) {
        throw new ErroApi(404, { erro: "Incidente não encontrado" });
      }
      await auditar(sql, ator, "ignorar", String(id), {});
      return { ok: true as const, id, status: "ignorado" };
    },

    async investigarIncidente(id: number, ator?: string) {
      const falhou = async (erro: string) => {
        if (!ator) return;
        try {
          await auditar(sql, ator, "investigar", String(id), { erro });
        } catch (e) {
          console.error(`investigar: auditoria falhou: ${msg(e)}`);
        }
      };
      let r;
      try {
        r = await ops.investigar(id);
      } catch (e) {
        await falhou(msg(e));
        throw e;
      }
      if ("erro" in r) {
        await falhou(r.erro);
        throw new ErroApi(r.erro.includes("não encontrado") ? 404 : 502, r);
      }
      if (ator) await auditar(sql, ator, "investigar", String(id), {});
      return r;
    },

    // --------------------------------------------------------- bloqueios
    async listarBloqueios(todos: boolean) {
      const rows = await sql`
        SELECT id, host(ip) ip, incidente_id, motivo, criado, expira, removido
        FROM vigia.bloqueios
        ${todos ? sql`` : sql`WHERE removido IS NULL`}
        ORDER BY criado DESC, id DESC LIMIT 500`;
      const info = await infoBloqueios(sql, rows.map((b) => Number(b.id)));
      return rows.map((b) => {
        const i = info.get(Number(b.id));
        return {
          id: Number(b.id),
          ip: b.ip as string,
          incidenteId: b.incidente_id === null ? null : Number(b.incidente_id),
          motivo: b.motivo as string | null,
          criado: iso(b.criado),
          expira: iso(b.expira),
          removido: iso(b.removido),
          /** jev | reserva | djair | api | sistema (ator da auditoria). */
          origem: i?.origem ?? "sistema",
          /** Duração escolhida (1 = 24 h, 7 = 7 dias); null se desconhecida. */
          dias: i?.dias ?? null,
        };
      });
    },

    async bloquearIp(
      v: { ip: string; duracao: Duracao; motivo?: string },
      ator: string,
    ) {
      try {
        const r = await ops.bloquear(
          v.ip,
          null,
          v.motivo ?? "Bloqueio manual de IP",
          ator,
          DIAS_DURACAO[v.duracao],
        );
        const [b] = await sql`SELECT expira FROM vigia.bloqueios
          WHERE id = ${r.bloqueioId}`;
        return {
          ok: true as const,
          bloqueioId: r.bloqueioId,
          ip: v.ip,
          duracao: v.duracao,
          expira: iso(b?.expira),
        };
      } catch (e) {
        if (e instanceof IpProtegido) {
          throw new ErroApi(409, {
            erro: `O IP ${e.ip} é protegido (${e.motivo}) e não foi bloqueado.`,
          });
        }
        if ((e as { code?: string })?.code === "22P02") {
          throw new ErroApi(400, { erro: "IP inválido" });
        }
        throw new ErroApi(502, { erro: msg(e) });
      }
    },

    /** Bloqueio ativo do IP (para desbloquear/prorrogar pelo IP). */
    async bloqueioAtivoDoIp(ip: string): Promise<number> {
      if (!ipValido(ip.trim())) throw new ErroApi(400, { erro: "IP inválido" });
      const [b] = await sql`SELECT id FROM vigia.bloqueios
        WHERE ip = ${normalizarIp(ip.trim())}::inet AND removido IS NULL
        ORDER BY id DESC LIMIT 1`;
      if (!b) {
        throw new ErroApi(404, { erro: `Nenhum bloqueio ativo para ${ip}` });
      }
      return Number(b.id);
    },

    async desbloquear(id: number, ator: string) {
      const [b] =
        await sql`SELECT host(ip) ip FROM vigia.bloqueios WHERE id = ${id}`;
      if (!b) throw new ErroApi(404, { erro: "Bloqueio não encontrado" });
      let r;
      try {
        r = await ops.desfazer(id, ator);
      } catch (e) {
        // desfazer pode vir da ação da notificação: avisa a falha também por push
        await ops.notificar("bloqueio_expirado", {
          titulo: `Falha ao remover bloqueio de ${b.ip}`,
          corpo: `${msg(e)}. Tente de novo em Bloqueios.`,
          url: "/bloqueios",
        });
        throw new ErroApi(502, { erro: msg(e) });
      }
      await ops.notificar("desfeito", {
        titulo: "Bloqueio desfeito",
        corpo: `${b.ip} foi desbloqueado.`,
        url: "/bloqueios",
      });
      return { ...r, bloqueioId: id, ip: b.ip as string };
    },

    async prorrogar(id: number, dias: number, ator: string) {
      const [x] = await sql`SELECT removido, host(ip) ip FROM vigia.bloqueios
        WHERE id = ${id}`;
      if (!x) throw new ErroApi(404, { erro: "Bloqueio não encontrado" });
      if (x.removido) throw new ErroApi(409, { erro: "Bloqueio já removido" });
      try {
        await ops.prorrogar(id, dias, ator);
      } catch (e) {
        if ((e as { code?: string })?.code === "22P02") {
          throw new ErroApi(400, { erro: "Valor inválido" });
        }
        throw new ErroApi(502, { erro: msg(e) });
      }
      const [b] =
        await sql`SELECT expira FROM vigia.bloqueios WHERE id = ${id}`;
      return {
        ok: true as const,
        bloqueioId: id,
        ip: x.ip as string,
        expira: iso(b?.expira),
      };
    },

    // ------------------------------------------------------ localizar IP
    async localizar(ip: string) {
      const x = ipConsultavel(ip);
      try {
        return await localizarIp(sql, d.geoIp, x, d.agora());
      } catch (e) {
        if (e instanceof ErroLocalizacao) {
          throw new ErroApi(502, { erro: e.message });
        }
        throw e;
      }
    },

    async dossie(ip: string, ator: string): Promise<string> {
      const x = ipConsultavel(ip);
      const t = await montarDossie(sql, d.geoIp, x, d.agora());
      await auditar(sql, ator, "dossie_ip", x, {});
      return t;
    },

    // ------------------------------------------------------------ regras
    async listarExcecoes() {
      const rows =
        await sql`SELECT id, tipo, valor, nota FROM vigia.excecoes ORDER BY id`;
      return rows.map((r) => ({
        id: Number(r.id),
        tipo: r.tipo as string,
        valor: r.valor as string,
        nota: (r.nota as string | null) ?? null,
      }));
    },

    async listarPermitidos() {
      const rows = await sql`
        SELECT id, regexp_replace(ip::text, '/(32|128)$', '') ip, expira, nota
        FROM vigia.permitidos ORDER BY id`;
      return rows.map((r) => ({
        id: Number(r.id),
        ip: r.ip as string,
        expira: iso(r.expira),
        nota: (r.nota as string | null) ?? null,
      }));
    },

    async adicionarExcecao(
      v: { tipo: "caminho"; valor: string; nota?: string },
      ator: string,
      erroStatus = 400,
    ) {
      const [r] = await sql`INSERT INTO vigia.excecoes (tipo, valor, nota)
        VALUES (${v.tipo}, ${v.valor}, ${v.nota ?? null}) RETURNING id`;
      try {
        const g = await ops.reaplicarGeo();
        await auditar(sql, ator, "excecao_criar", v.valor, {
          id: Number(r.id),
        });
        await reaplicarProtecoesSilencioso();
        return { id: Number(r.id), ...g };
      } catch (e) {
        await sql`DELETE FROM vigia.excecoes WHERE id = ${r.id}`;
        throw new ErroApi(erroStatus, { erro: msg(e) });
      }
    },

    async removerExcecao(id: number, ator: string) {
      const r = await sql`DELETE FROM vigia.excecoes WHERE id = ${id}
        RETURNING id, tipo, valor, nota`;
      if (!r.length) throw new ErroApi(404, { erro: "Exceção não encontrada" });
      try {
        const g = await ops.reaplicarGeo();
        await auditar(sql, ator, "excecao_remover", String(r[0].valor), { id });
        await reaplicarProtecoesSilencioso();
        return { ok: true as const, removida: String(r[0].valor), ...g };
      } catch (e) {
        const x = r[0];
        await sql`INSERT INTO vigia.excecoes (id, tipo, valor, nota)
          VALUES (${x.id}, ${x.tipo}, ${x.valor}, ${x.nota})`;
        throw new ErroApi(502, { erro: msg(e) });
      }
    },

    async adicionarPermitido(
      v: { ip: string; horas?: number; nota?: string },
      ator: string,
    ) {
      const expira = v.horas
        ? new Date(d.agora().getTime() + v.horas * 3_600_000)
        : null;
      const [antes] = await sql`SELECT id, expira, nota FROM vigia.permitidos
        WHERE ip = ${v.ip}::inet`;
      const [r] = await sql`INSERT INTO vigia.permitidos (ip, expira, nota)
        VALUES (${v.ip}::inet, ${expira}, ${v.nota ?? null})
        ON CONFLICT (ip) DO UPDATE SET expira = EXCLUDED.expira,
          nota = COALESCE(EXCLUDED.nota, vigia.permitidos.nota)
        RETURNING id`;
      try {
        const g = await ops.reaplicarGeo();
        await auditar(sql, ator, "permitido_criar", v.ip, {
          id: Number(r.id),
          expira: iso(expira),
        });
        return { id: Number(r.id), ip: v.ip, expira: iso(expira), ...g };
      } catch (e) {
        if (antes) {
          await sql`UPDATE vigia.permitidos
            SET expira = ${antes.expira}, nota = ${antes.nota} WHERE id = ${antes.id}`;
        } else {
          await sql`DELETE FROM vigia.permitidos WHERE id = ${r.id}`;
        }
        throw new ErroApi(400, { erro: msg(e) });
      }
    },

    async removerPermitido(id: number, ator: string) {
      const r = await sql`DELETE FROM vigia.permitidos WHERE id = ${id}
        RETURNING id, ip::text ip, expira, nota`;
      if (!r.length) {
        throw new ErroApi(404, { erro: "Permitido não encontrado" });
      }
      try {
        const g = await ops.reaplicarGeo();
        await auditar(sql, ator, "permitido_remover", String(r[0].ip), { id });
        return { ok: true as const, removido: String(r[0].ip), ...g };
      } catch (e) {
        const x = r[0];
        await sql`INSERT INTO vigia.permitidos (id, ip, expira, nota)
          VALUES (${x.id}, ${x.ip}::inet, ${x.expira}, ${x.nota})
          ON CONFLICT (ip) DO NOTHING`;
        throw new ErroApi(502, { erro: msg(e) });
      }
    },

    // ------------------------------------------- ASNs de datacenter/VPS
    listarAsns,

    /** Lista auditada (ferramenta MCP de escopo escrever). */
    async listarAsnDatacenter(ator: string) {
      const geral = await lerGeral();
      const asns = await listarAsns();
      await auditar(sql, ator, "asn_datacenter_listar", null, {
        total: asns.length,
      });
      return { ativo: geral.bloquearDatacenter, asns };
    },

    async adicionarAsnDatacenter(
      v: { asn: number; nome: string },
      ator: string,
    ) {
      const [antes] = await sql`SELECT nome, ativo FROM vigia.asn_datacenter
        WHERE asn = ${v.asn}`;
      await sql`INSERT INTO vigia.asn_datacenter (asn, nome, ativo)
        VALUES (${v.asn}, ${v.nome}, true)
        ON CONFLICT (asn) DO UPDATE SET nome = EXCLUDED.nome, ativo = true`;
      try {
        const g = await ops.reaplicarGeo();
        await auditar(sql, ator, "asn_datacenter_criar", String(v.asn), {
          nome: v.nome,
        });
        return { asn: v.asn, nome: v.nome, ativo: true, ...g };
      } catch (e) {
        if (antes) {
          await sql`UPDATE vigia.asn_datacenter
            SET nome = ${antes.nome}, ativo = ${antes.ativo} WHERE asn = ${v.asn}`;
        } else {
          await sql`DELETE FROM vigia.asn_datacenter WHERE asn = ${v.asn}`;
        }
        throw new ErroApi(502, { erro: msg(e) });
      }
    },

    async removerAsnDatacenter(asn: number, ator: string) {
      const r = await sql`DELETE FROM vigia.asn_datacenter WHERE asn = ${asn}
        RETURNING asn, nome, ativo`;
      if (!r.length) {
        throw new ErroApi(404, { erro: `AS${asn} não está na lista` });
      }
      try {
        const g = await ops.reaplicarGeo();
        await auditar(sql, ator, "asn_datacenter_remover", String(asn), {
          nome: r[0].nome,
        });
        return { ok: true as const, removido: asn, ...g };
      } catch (e) {
        const x = r[0];
        await sql`INSERT INTO vigia.asn_datacenter (asn, nome, ativo)
          VALUES (${x.asn}, ${x.nome}, ${x.ativo}) ON CONFLICT (asn) DO NOTHING`;
        throw new ErroApi(502, { erro: msg(e) });
      }
    },

    // ------------------------------------------------------ configurações
    async definirGeral(
      v: {
        modoObservacao?: boolean;
        geoAtivo?: boolean;
        bloqueioAutoAtivo?: boolean;
        limiares?: { bruteforceN?: number; rateK?: number };
        jevLimiar?: number;
        jevExigeSegunda?: boolean;
        bloquearDatacenter?: boolean;
      },
      ator: string,
    ) {
      if (
        v.jevLimiar !== undefined &&
        !(v.jevLimiar >= JEV_LIMIAR_MIN && v.jevLimiar <= JEV_LIMIAR_MAX)
      ) {
        throw new ErroApi(400, {
          erro:
            `jevLimiar deve estar entre ${JEV_LIMIAR_MIN} e ${JEV_LIMIAR_MAX}`,
        });
      }
      const antes = await lerGeral();
      // 1º a regra geo (efeito externo); só com sucesso grava o resto.
      let zonasComFalha: string[] = [];
      if (v.geoAtivo !== undefined || v.bloquearDatacenter !== undefined) {
        if (v.geoAtivo !== undefined) {
          await gravarConfig(sql, "geo_ativo", v.geoAtivo);
        }
        if (v.bloquearDatacenter !== undefined) {
          await gravarConfig(sql, "bloquear_datacenter", v.bloquearDatacenter);
        }
        try {
          zonasComFalha = (await ops.reaplicarGeo()).zonasComFalha;
        } catch (e) {
          if (v.geoAtivo !== undefined) {
            await gravarConfig(sql, "geo_ativo", antes.geoAtivo);
          }
          if (v.bloquearDatacenter !== undefined) {
            await gravarConfig(
              sql,
              "bloquear_datacenter",
              antes.bloquearDatacenter,
            );
          }
          throw new ErroApi(502, { erro: msg(e) });
        }
      }
      await sql.begin(async (tx) => {
        const t = tx as unknown as Sql;
        if (v.modoObservacao !== undefined) {
          await gravarConfig(
            t,
            "modo_observacao_ate",
            v.modoObservacao ? OBSERVACAO_SEMPRE : d.agora().toISOString(),
          );
        }
        if (v.bloqueioAutoAtivo !== undefined) {
          await gravarConfig(t, "bloqueio_auto_ativo", v.bloqueioAutoAtivo);
        }
        if (v.limiares?.bruteforceN !== undefined) {
          await gravarConfig(t, "limiar_bruteforce_n", v.limiares.bruteforceN);
        }
        if (v.limiares?.rateK !== undefined) {
          await gravarConfig(t, "limiar_rate_k", v.limiares.rateK);
        }
        if (v.jevLimiar !== undefined) {
          await gravarConfig(t, "jev_limiar", v.jevLimiar);
        }
        if (v.jevExigeSegunda !== undefined) {
          await gravarConfig(t, "jev_exige_segunda", v.jevExigeSegunda);
        }
      });
      await auditar(sql, ator, "config_geral", null, { antes, mudancas: v });
      return { ...(await lerGeral()), zonasComFalha, antes };
    },

    lerIa,

    async definirIa(
      itens: { papel: Papel; modelo: string; timeoutMs?: number }[],
      ator: string,
    ) {
      const antes = await lerIa();
      for (const x of itens) {
        await sql`UPDATE vigia.config_ia SET
            falhas_seguidas = CASE WHEN modelo <> ${x.modelo} THEN 0 ELSE falhas_seguidas END,
            degradado_desde = CASE WHEN modelo <> ${x.modelo} THEN NULL ELSE degradado_desde END,
            modelo = ${x.modelo},
            timeout_ms = COALESCE(${x.timeoutMs ?? null}::int, timeout_ms)
          WHERE papel = ${x.papel}`;
      }
      await auditar(sql, ator, "config_ia", null, { itens });
      return {
        ok: true as const,
        antes: antes.map((a) => ({
          papel: a.papel,
          modelo: a.modelo,
          timeoutMs: a.timeoutMs,
        })),
        depois: (await lerIa()).map((a) => ({
          papel: a.papel,
          modelo: a.modelo,
          timeoutMs: a.timeoutMs,
        })),
      };
    },

    // ------------------------------------------------------- proteções
    async protecoes() {
      const p = await protecoesAtuais(sql);
      const oc = p.modo === "observar"
        ? await ocorrenciasRecentes(sql, d.agora())
        : null;
      return { ...p, ocorrencias24h: oc };
    },

    async definirProtecoes(
      v: { modo?: ModoProtecao; rateAtivo?: boolean },
      ator: string,
    ) {
      const antes = await protecoesAtuais(sql);
      if (v.modo !== undefined) {
        await gravarConfig(sql, "protecoes_modo", v.modo);
      }
      if (v.rateAtivo !== undefined) {
        await gravarConfig(sql, "protecoes_rate_ativo", v.rateAtivo);
      }
      await auditar(sql, ator, "protecoes_config", null, {
        antes: { modo: antes.modo, rateAtivo: antes.rateAtivo },
        mudancas: v,
      });
      let zonas;
      try {
        zonas = await ops.aplicarProtecoes();
      } catch (e) {
        throw new ErroApi(502, { erro: msg(e) });
      }
      const depois = await protecoesAtuais(sql);
      return {
        antes: { modo: antes.modo, rateAtivo: antes.rateAtivo },
        modo: depois.modo,
        rateAtivo: depois.rateAtivo,
        zonas,
      };
    },

    /** IP(s) do servidor do Vigia, protegidos automaticamente. */
    ipsServidor: () => listarIpsServidor(sql, d.agora()),

    // ------------------------------------------- auditoria dos sites
    /** Achados abertos por host, última execução e lista de hosts (com sugestões). */
    async achadosAuditoria() {
      try {
        await semearHosts(sql, d.agora());
      } catch (e) {
        console.error(`auditoria: sugerir hosts falhou: ${msg(e)}`);
      }
      const a = await listarAchados(sql);
      return {
        ...a,
        rodando: ops.auditoriaRodando?.() ?? false,
        alvos: await listarHosts(sql),
      };
    },

    async rodarAuditoria(ator: string) {
      if (!ops.rodarAuditoria) {
        throw new ErroApi(503, { erro: "Auditoria indisponível" });
      }
      const r = await ops.rodarAuditoria();
      await auditar(sql, ator, "auditoria_rodar", null, { estado: r.estado });
      const mensagem = {
        iniciada:
          "Auditoria iniciada; leva alguns minutos (1 requisição/s por host). Consulte os achados depois.",
        ja_rodando: "Já há uma auditoria em andamento.",
        aguarde: "A auditoria acabou de rodar; aguarde 2 minutos.",
      }[r.estado];
      return { estado: r.estado, mensagem };
    },

    adicionarHostAuditoria: (host: string, ator: string) =>
      adicionarHost(sql, host, ator),

    removerHostAuditoria: (host: string, ator: string) =>
      removerHost(sql, host, ator),

    definirAmbienteHost: (
      host: string,
      ambiente: "producao" | "teste",
      ator: string,
    ) => definirAmbienteHost(sql, host, ambiente, ator),

    // ----------------------------- varredura profunda (atalhos da auditoria)
    /** Mesma visão da auditoria, enfatizando a varredura profunda e o ambiente. */
    listarVarredura: () => s.achadosAuditoria(),
    /** Roda a varredura (auditoria completa, inclusive checagens profundas). */
    rodarVarredura: (ator: string) => s.rodarAuditoria(ator),

    // ----------------------------------------------- Revisor IA (caixa-preta)
    /** Última análise do Revisor + se está rodando agora. */
    async achadosRevisao() {
      const r = await listarRevisao(sql);
      return { ...r, rodando: ops.revisaoRodando?.() ?? false };
    },

    /** Dispara o Revisor sobre os achados atuais + apps, em segundo plano. */
    async rodarRevisao(ator: string) {
      if (!ops.rodarRevisao) {
        throw new ErroApi(503, {
          erro:
            "Revisor IA indisponível (confira o papel 'revisor' em Configurações → IAs).",
        });
      }
      const entrada = {
        achados: await listarAchados(sql),
        apps: await s.apps().catch(() => []),
      };
      const r = await ops.rodarRevisao(entrada);
      await auditar(sql, ator, "revisao_rodar", null, { estado: r.estado });
      const mensagem = {
        iniciada:
          "Revisão iniciada; leva cerca de 1 minuto. Consulte achados_revisao depois.",
        ja_rodando: "Já há uma revisão em andamento.",
      }[r.estado];
      return { estado: r.estado, mensagem };
    },

    // ---------------------------------------- cabeçalhos de segurança (CF)
    async verCabecalhos() {
      const cfg = await lerConfigGeral(sql);
      const modo = (MODOS_CABECALHOS as string[]).includes(
          cfg.get("cabecalhos_modo") as string,
        )
        ? cfg.get("cabecalhos_modo") as ModoCabecalhos
        : "desligado";
      const zonas = cfg.get("cabecalhos_zonas");
      return { modo, zonas: Array.isArray(zonas) ? zonas : [] };
    },

    async definirCabecalhos(modo: ModoCabecalhos, ator: string) {
      if (!(MODOS_CABECALHOS as string[]).includes(modo)) {
        throw new ErroApi(400, { erro: "Modo inválido" });
      }
      if (!ops.aplicarCabecalhos) {
        throw new ErroApi(503, { erro: "Cabeçalhos indisponíveis" });
      }
      const zonas = await ops.aplicarCabecalhos(modo);
      await sql`INSERT INTO vigia.config_geral (chave, valor) VALUES
        ('cabecalhos_modo', ${sql.json(modo)}),
        ('cabecalhos_zonas', ${sql.json(zonas)})
        ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
      await auditar(sql, ator, "cabecalhos_definir", null, { modo });
      return { modo, zonas };
    },

    // ------------------------------------------------- auditoria do Supabase
    async achadosSupabase() {
      const instancias = (await listarSupabaseInstancias(sql)).map((i) => ({
        nome: i.nome,
        url: i.url,
      })); // sem a anon key
      return {
        instancias,
        resultados: await listarSupabaseResultados(sql),
        rodando: ops.supabaseRodando?.() ?? false,
      };
    },

    adicionarSupabase: async (
      nome: string,
      url: string,
      anonKey: string,
      ator: string,
    ) => {
      let inst;
      try {
        inst = await salvarSupabaseInstancia(sql, nome, url, anonKey);
      } catch (e) {
        throw new ErroApi(400, { erro: msg(e) });
      }
      await auditar(sql, ator, "supabase_instancia", inst.nome, {
        url: inst.url,
      });
      return { nome: inst.nome, url: inst.url };
    },

    removerSupabase: async (nome: string, ator: string) => {
      const ok = await removerSupabaseInstancia(sql, nome);
      if (ok) await auditar(sql, ator, "supabase_instancia_removida", nome, {});
      return { ok };
    },

    async auditarSupabaseAgora(ator: string) {
      if (!ops.auditarSupabase) {
        throw new ErroApi(503, { erro: "Auditoria do Supabase indisponível" });
      }
      const r = await ops.auditarSupabase();
      await auditar(sql, ator, "supabase_auditar", null, { estado: r.estado });
      const mensagem = {
        iniciada:
          "Auditoria do Supabase iniciada; consulte achados_supabase em alguns segundos.",
        ja_rodando: "Já há uma auditoria do Supabase em andamento.",
        sem_instancia:
          "Nenhuma instância Supabase cadastrada (adicione URL + anon key primeiro).",
      }[r.estado];
      return { estado: r.estado, mensagem };
    },

    // ------------------------------------------- análise de código (zip/GitHub)
    async achadosCodigo() {
      const a = await listarAchadosCodigo(sql);
      return { ...a, rodando: ops.revisaoCodigoRodando?.() ?? false };
    },

    /** Dispara a análise de um repo público do GitHub pelo Revisor. */
    async analisarRepoGithub(url: string, ator: string) {
      if (!ops.analisarRepo) {
        throw new ErroApi(503, { erro: "Análise de código indisponível" });
      }
      let alvo;
      try {
        alvo = githubZip(url); // valida SSRF antes de aceitar
      } catch (e) {
        throw new ErroApi(400, { erro: msg(e) });
      }
      const r = await ops.analisarRepo({ tipo: "github", url });
      await auditar(
        sql,
        ator,
        "codigo_analisar",
        `github:${alvo.owner}/${alvo.repo}`,
        {
          estado: r.estado,
        },
      );
      return {
        estado: r.estado,
        repo: `${alvo.owner}/${alvo.repo}`,
        ...mensagemCodigo(r.estado),
      };
    },

    /** Dispara a análise de um zip de repositório enviado. */
    async analisarRepoZip(nome: string, bytes: Uint8Array, ator: string) {
      if (!ops.analisarRepo) {
        throw new ErroApi(503, { erro: "Análise de código indisponível" });
      }
      if (!bytes.length) throw new ErroApi(400, { erro: "Zip vazio" });
      const r = await ops.analisarRepo({ tipo: "zip", nome, bytes });
      await auditar(sql, ator, "codigo_analisar", `zip:${nome}`, {
        estado: r.estado,
      });
      return { estado: r.estado, repo: nome, ...mensagemCodigo(r.estado) };
    },

    // ----------------------------------------- conectores (pedidos/decisão)
    async pedidosConector() {
      return { pedidos: await listarPedidosConector(sql) };
    },

    /** Decide uma faixa de conector e reaplica a regra de skip na borda. */
    async decidirConector(
      entrada: { id?: number; faixa?: string; modo: ModoDecisaoConector; horas?: number },
      ator: string,
    ) {
      let r;
      try {
        r = await aplicarDecisaoConector(sql, d.agora(), entrada, ator);
      } catch (e) {
        throw new ErroApi(400, { erro: msg(e) });
      }
      // Libera (ou retira) na borda agora. Se indisponível, a decisão fica no
      // banco e é refletida na próxima sincronização horária da infra.
      const zonasComFalha = (await ops.reaplicarConector?.()) ?? null;
      return { ...r, zonasComFalha };
    },

    // ------------------------------------- campanhas de teste ofensivo
    listarCampanhas: () => listarCampanhas(sql),
    verCampanha: (id: number) => verCampanha(sql, id),
    criarCampanha: (
      v: { alvo: string; tipo: TipoAtaque; config?: Record<string, unknown> },
      ator: string,
    ) => criarCampanha(sql, v, ator),
    autorizarCampanha: (id: number, confirmToken: string, ator: string) =>
      autorizarCampanha(sql, id, confirmToken, ator),
    cancelarCampanha: (id: number, ator: string) =>
      cancelarCampanha(sql, id, ator),
    rodarCampanha: (id: number, ator: string) =>
      rodarCampanha(sql, id, (c: Campanha) => {
        if (!ops.executarAtaque) {
          throw new ErroApi(503, {
            erro:
              "Runner de teste ofensivo indisponível neste processo (exige runner isolado).",
          });
        }
        return ops.executarAtaque(c);
      }, ator),

    /**
     * Prompt pt-BR para o Claude Code: achados abertos do host/app (um app
     * junta os achados dos seus domínios e vice-versa), roteiro de 8 pontos.
     */
    async promptCorrecao(bruto?: string | null) {
      let host: string | null = null;
      if (bruto && bruto.trim()) {
        const t = bruto.trim();
        host = t.includes("/")
          ? (CHAVE_APP.test(t) ? t : null)
          : normalizarHost(t);
        if (!host) {
          throw new ErroApi(400, {
            erro: "Host inválido: use o nome do site ou projeto/serviço",
          });
        }
      }
      const { grupos } = await listarAchados(sql);
      let filtrados = grupos;
      if (host) {
        const rel = new Set([host]);
        for (const a of await listarApps(sql)) {
          if (a.chave === host || a.dominios.includes(host)) {
            rel.add(a.chave);
            a.dominios.forEach((x) => rel.add(x));
          }
        }
        filtrados = grupos.filter((g) => rel.has(g.host));
      }
      return {
        host,
        achados: filtrados.reduce((n, g) => n + g.achados.length, 0),
        texto: montarPrompt(filtrados, { host }),
      };
    },

    // ------------------------------------------- apps do EasyPanel
    async apps() {
      if (!(ops.easypanelConfigurado?.() ?? false)) {
        return {
          configurado: false,
          situacao: "nao_configurado",
          instrucoes: INSTRUCOES_EASYPANEL,
          estado: null,
          apps: [],
        };
      }
      const estado = await estadoEasypanel(sql);
      // nao_configurado | token_invalido | erro | ok | aguardando
      const situacao = estado?.autenticacao === "token_invalido"
        ? "token_invalido"
        : (estado?.falhasSeguidas ?? 0) > 0
        ? "erro"
        : estado?.ultimoOk || estado?.autenticacao === "ok"
        ? "ok"
        : "aguardando";
      return {
        configurado: true,
        situacao,
        estado,
        apps: await listarApps(sql),
      };
    },

    // ------------------------------------------- servidor (host)
    servidorResumo: () => servidor.resumo(),
    servidorSmart: (ator: string) => servidor.smart(ator),
    servidorTesteDisco: (mb: number | undefined, ator: string) =>
      servidor.testeDisco(mb, ator),
    async servidorComando(
      nome: string,
      params: Record<string, unknown>,
      ator: string,
    ) {
      try {
        return await servidor.comando(nome, params, ator);
      } catch (e) {
        if (e instanceof ErroSsh) {
          const naoConfig = /não configurado/.test(e.message);
          throw new ErroApi(naoConfig ? 503 : 400, { erro: e.message });
        }
        throw e;
      }
    },
    async servidorChave() {
      try {
        return await servidor.chave();
      } catch (e) {
        throw new ErroApi(500, { erro: msg(e) });
      }
    },
    servidorCatalogo: () => servidor.catalogo(),

    async statusApp(projeto: string, servico: string) {
      const a = await verApp(sql, projeto, servico);
      if (!a) {
        throw new ErroApi(404, {
          erro: (ops.easypanelConfigurado?.() ?? false)
            ? "App não encontrado no EasyPanel"
            : INSTRUCOES_EASYPANEL,
        });
      }
      const rel = new Set([a.chave, ...a.dominios]);
      const { grupos } = await listarAchados(sql);
      return {
        app: a,
        achados: grupos.filter((g) => rel.has(g.host))
          .flatMap((g) => g.achados.map((x) => ({ host: g.host, ...x }))),
      };
    },
  };

  /** Exceções mudaram: as proteções também excluem esses caminhos. */
  async function reaplicarProtecoesSilencioso() {
    try {
      await ops.aplicarProtecoes();
    } catch (e) {
      console.error(`protecoes: reaplicar falhou: ${msg(e)}`);
    }
  }

  return s;
}
