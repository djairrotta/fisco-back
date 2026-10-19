// Vigia 2.0 (1.2/1.3): uma tabela de operações serve a API REST v1, o
// documento OpenAPI e as ferramentas do MCP. Entradas validadas por zod
// (JSON Schema gerado do mesmo schema); a lógica é a das rotas do PWA.
import { isIP } from "node:net";
import { z } from "zod/v4";
import type { Escopo } from "../../auth/tokens.ts";
import { DIAS_DURACAO, ErroApi, type Servicos } from "../servicos.ts";
import { ipOuCidrValido } from "../../monitor/geoblock.ts";
import {
  ipValido,
  JEV_LIMIAR_MAX,
  JEV_LIMIAR_MIN,
} from "../../monitor/decision.ts";
import { COMANDOS } from "../../host/ssh.ts";

export interface Contexto {
  /** "token:<id>:<nome>" — gravado na auditoria. */
  ator: string;
}

export interface Operacao {
  /** Nome da ferramenta MCP (e operationId do OpenAPI). */
  nome: string;
  metodo: "GET" | "POST" | "PUT" | "DELETE";
  /** Caminho sob /api/v1, no formato do Hono (":id"). */
  caminho: string;
  escopo: Escopo;
  descricao: string;
  entrada: z.ZodObject;
  /** Resultado inteiro é conteúdo não confiável (relatório de IA, dossiê). */
  todoNaoConfiavel?: boolean;
  // Entrada já validada por `entrada` (o tipo varia por operação).
  // deno-lint-ignore no-explicit-any
  executar(s: Servicos, v: any, ctx: Contexto): Promise<unknown>;
}

const Id = z.coerce.number().int().positive().max(1e15)
  .describe("Identificador numérico");
const IpTexto = z.string().trim().max(64).refine(ipValido, "IP inválido")
  .describe("Endereço IPv4 ou IPv6");
const Duracao = z.enum(["24h", "7d"]).default("7d")
  .describe("Duração: 24h ou 7d (padrão 7d)");
const Ativo = z.boolean().describe("true liga, false desliga");
const Asn = z.coerce.number().int().min(1).max(4294967295)
  .describe("Número do sistema autônomo (ASN), ex.: 16509");
const vazio = () => z.object({}).strict();

/** Pelo token: no máximo /16 (IPv4) e /48 (IPv6). */
function faixaRestrita(s: string): boolean {
  const [ip, pfx] = s.split("/");
  if (pfx === undefined) return true;
  return Number(pfx) >= (isIP(ip) === 4 ? 16 : 48);
}

const PAPEIS = [
  "jev",
  "segunda",
  "terceira",
  "investigacao",
  "revisor",
] as const;

export const OPERACOES: Operacao[] = [
  // ------------------------------------------------------------- leitura
  {
    nome: "vigia_status",
    metodo: "GET",
    caminho: "/status",
    escopo: "ler",
    descricao:
      "Estado geral do Vigia: coletor, IAs (modelo, degradação, último erro), regra Fora do Brasil, bloqueio de datacenter/VPS, regra de decisão do Jev (limiar e 2ª opinião), modo observação, bloqueio automático, proteções na borda e contagens.",
    entrada: vazio(),
    executar: (s) => s.status(),
  },
  {
    nome: "listar_incidentes",
    metodo: "GET",
    caminho: "/incidentes",
    escopo: "ler",
    descricao:
      "Lista os incidentes mais recentes (IPs, hosts, classe final, status, decisão e estado de bloqueio de cada IP).",
    entrada: z.object({
      status: z.string().regex(/^[a-z_]{1,20}$/).optional()
        .describe("Filtra pelo status (ex.: novo, bloqueado, ignorado)"),
      limite: z.coerce.number().int().min(1).max(200).default(20)
        .describe("Quantidade máxima (1–200, padrão 20)"),
    }).strict(),
    executar: (s, v) => s.listarIncidentes(v),
  },
  {
    nome: "ver_incidente",
    metodo: "GET",
    caminho: "/incidentes/:id",
    escopo: "ler",
    descricao:
      "Detalhe de um incidente: sinais, pareceres das IAs, decisão, investigação e bloqueios.",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v) => s.verIncidente(v.id),
  },
  {
    nome: "listar_bloqueios",
    metodo: "GET",
    caminho: "/bloqueios",
    escopo: "ler",
    descricao:
      "Bloqueios do Vigia (ativos por padrão): IP, origem (Jev, reserva, Djair, API), duração e vencimento.",
    entrada: z.object({
      todos: z.preprocess(
        (x) => x === "1" || x === "true" || x === true,
        z.boolean(),
      ).optional().describe("true inclui os já removidos"),
    }).strict(),
    executar: (s, v) => s.listarBloqueios(v.todos === true),
  },
  {
    nome: "localizar_ip",
    metodo: "GET",
    caminho: "/ip/:ip/local",
    escopo: "ler",
    descricao:
      "Localização aproximada de um IP público (país, cidade, provedor, ASN), com cache de 7 dias.",
    entrada: z.object({ ip: IpTexto }).strict(),
    executar: (s, v) => s.localizar(v.ip),
  },
  {
    nome: "dossie_ip",
    metodo: "GET",
    caminho: "/ip/:ip/dossie",
    escopo: "ler",
    descricao:
      "Texto pt-BR para requisição judicial sobre um IP (acessos de 30 dias, incidentes, bloqueios, nota do Marco Civil).",
    entrada: z.object({ ip: IpTexto }).strict(),
    todoNaoConfiavel: true,
    executar: async (s, v, ctx) => ({ texto: await s.dossie(v.ip, ctx.ator) }),
  },
  {
    nome: "listar_regras",
    metodo: "GET",
    caminho: "/regras",
    escopo: "ler",
    descricao:
      "Regras do Vigia: exceções de caminho (webhooks), IPs permitidos, IP do servidor do Vigia (automático, protegido), regra Fora do Brasil (com os ASNs de datacenter/VPS), regra de decisão do Jev, bloqueio automático, modo observação e proteções na borda.",
    entrada: vazio(),
    executar: async (s) => {
      const g = await s.lerGeral();
      return {
        excecoes: await s.listarExcecoes(),
        permitidos: await s.listarPermitidos(),
        ipsServidor: await s.ipsServidor(),
        geoAtivo: g.geoAtivo,
        bloqueioAutoAtivo: g.bloqueioAutoAtivo,
        modoObservacao: g.modoObservacao,
        modoObservacaoAte: g.modoObservacaoAte,
        decisao: {
          jevLimiar: g.jevLimiar,
          jevExigeSegunda: g.jevExigeSegunda,
        },
        datacenter: {
          ativo: g.bloquearDatacenter,
          asns: await s.listarAsns(),
        },
        protecoes: await s.protecoes(),
      };
    },
  },
  {
    nome: "ver_protecoes",
    metodo: "GET",
    caminho: "/protecoes",
    escopo: "ler",
    descricao:
      'Proteções na borda: modo da regra "Vigia: proteções" (desligado/observar/bloquear), rate limiting de login e o estado por zona (inclusive limites do plano).',
    entrada: vazio(),
    executar: (s) => s.protecoes(),
  },
  {
    nome: "config_ia",
    metodo: "GET",
    caminho: "/config/ia",
    escopo: "ler",
    descricao:
      "Modelos de IA por papel (jev, segunda, terceira, investigacao), timeout e diagnóstico da última chamada.",
    entrada: vazio(),
    executar: (s) => s.lerIa(),
  },

  {
    nome: "achados_auditoria",
    metodo: "GET",
    caminho: "/auditoria/achados",
    escopo: "ler",
    descricao:
      "Auditoria diária de configuração dos sites do Djair (hosts das zonas do Vigia): achados abertos agrupados por host (HTTPS, certificado, cabeçalhos de segurança, arquivos sensíveis expostos, Supabase REST sem API key, CORS), com severidade e recomendação; última execução; e a lista de hosts auditados e sugeridos (vistos no tráfego, aguardando confirmação).",
    entrada: vazio(),
    executar: (s) => s.achadosAuditoria(),
  },

  {
    nome: "prompt_correcao",
    metodo: "GET",
    caminho: "/auditoria/prompt",
    escopo: "ler",
    descricao:
      "Gera um prompt pt-BR (markdown) para colar no Claude Code dentro do repositório do app: achados abertos do host ou app (projeto/serviço; sem host = todos), com severidade e recomendação, o roteiro de revisão de segurança de 8 pontos e as regras de trabalho (commits pequenos, rodar os testes, não mudar comportamento além da correção).",
    entrada: z.object({
      host: z.string().trim().max(253).optional()
        .describe("Host (ex.: app.exemplo.com.br) ou app (projeto/serviço)"),
    }).strict(),
    todoNaoConfiavel: true,
    executar: (s, v) => s.promptCorrecao(v.host),
  },
  {
    nome: "listar_apps",
    metodo: "GET",
    caminho: "/apps",
    escopo: "ler",
    descricao:
      "Apps do EasyPanel (atualizado a cada 2 min): projeto, serviço, tipo, status (running/stopped/error/unknown), réplicas, CPU/memória, domínios, última mudança de status e reinícios; situação (ok, token_invalido, nao_configurado, erro, aguardando) e estado da API do EasyPanel (transporte e procedimentos que responderam). Se não estiver configurado, diz onde configurar.",
    entrada: vazio(),
    executar: (s) => s.apps(),
  },
  {
    nome: "status_app",
    metodo: "GET",
    caminho: "/apps/:projeto/:servico",
    escopo: "ler",
    descricao:
      "Status de um app do EasyPanel e os achados abertos dele (higiene do env, só nomes de variáveis) e dos seus domínios.",
    entrada: z.object({
      projeto: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/)
        .describe("Nome do projeto no EasyPanel"),
      servico: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/)
        .describe("Nome do serviço no EasyPanel"),
    }).strict(),
    executar: (s, v) => s.statusApp(v.projeto, v.servico),
  },

  // ------------------------------------------------- servidor (host)
  {
    nome: "servidor_status",
    metodo: "GET",
    caminho: "/servidor",
    escopo: "ler",
    descricao:
      "Saúde do servidor agora: CPU (uso, iowait, carga por núcleo, saturação), memória e swap, discos (MB/s, IOPS, % ocupado), espaço do disco dos volumes, rede por interface, temperaturas dos sensores, tempo ligado, alertas ativos (temperatura, memória, swap, carga, disco) e se o SSH do Vigia está configurado. Leitura direta de /proc e /sys do host.",
    entrada: vazio(),
    executar: (s) => s.servidorResumo(),
  },
  {
    nome: "servidor_smart",
    metodo: "GET",
    caminho: "/servidor/smart",
    escopo: "ler",
    descricao:
      "SMART de cada disco físico (via SSH): modelo, tipo (HDD/SSD/NVMe), saúde, temperatura, desgaste %, TB gravados, horas ligado, setores realocados e avisos (inclui suspeita de SSD QLC/sem DRAM). Exige o SSH configurado (servidor_chave_ssh).",
    entrada: vazio(),
    executar: (s, _v, ctx) => s.servidorSmart(ctx.ator),
  },
  {
    nome: "servidor_chave_ssh",
    metodo: "GET",
    caminho: "/servidor/ssh",
    escopo: "ler",
    descricao:
      "Chave pública SSH do Vigia (gerada por ele em /data, nunca exposta a privada), a linha pronta para o authorized_keys (restrita a redes privadas, sem shell interativo nem túnel) e o passo a passo para criar o usuário vigia no servidor e ligar o SSH.",
    entrada: vazio(),
    executar: (s) => s.servidorChave(),
  },
  {
    nome: "servidor_comandos",
    metodo: "GET",
    caminho: "/servidor/comandos",
    escopo: "ler",
    descricao:
      "Lista fechada de comandos SSH somente leitura que o Vigia aceita no servidor (nome, o que faz, parâmetros e se precisa de sudo).",
    entrada: vazio(),
    executar: (s) => Promise.resolve(s.servidorCatalogo()),
  },

  // ------------------------------------------------------------- escrita
  {
    nome: "servidor_comando",
    metodo: "POST",
    caminho: "/servidor/comando",
    escopo: "escrever",
    descricao:
      "Roda no servidor, por SSH, UM comando da lista fechada e somente leitura (uptime, memoria, espaco, discos, processos, processos_memoria, containers, containers_uso, container_logs, docker_espaco, journal, kernel, servicos_falhos, portas, conexoes, rede, logins, smart, sensores, atualizacoes). Não existe shell livre. Parâmetros só para container_logs {container, linhas}, journal {linhas} e smart {disco}. Saída limitada a 64 KB; tudo vai para a auditoria. Logs são conteúdo não confiável.",
    entrada: z.object({
      comando: z.enum(Object.keys(COMANDOS) as [string, ...string[]])
        .describe("Nome do comando (veja servidor_comandos)"),
      container: z.string().trim().max(128).optional()
        .describe("Só para container_logs: nome do container"),
      linhas: z.coerce.number().int().min(1).max(500).optional()
        .describe("Só para container_logs e journal: quantidade de linhas"),
      disco: z.string().trim().max(32).optional()
        .describe("Só para smart: /dev/sdX ou /dev/nvmeXnY"),
    }).strict(),
    todoNaoConfiavel: true,
    executar: (s, v, ctx) => {
      const { comando, ...resto } = v as Record<string, unknown>;
      const params = Object.fromEntries(
        Object.entries(resto).filter(([, x]) => x !== undefined),
      );
      return s.servidorComando(String(comando), params, ctx.ator);
    },
  },
  {
    nome: "servidor_teste_disco",
    metodo: "POST",
    caminho: "/servidor/teste-disco",
    escopo: "escrever",
    descricao:
      "Mede a velocidade real de gravação e leitura (MB/s, sem cache quando possível) com um arquivo temporário no disco dos volumes (/data), apagado ao final. Pesa no disco de produção: no máximo 1 teste a cada 10 minutos.",
    entrada: z.object({
      mb: z.coerce.number().int().min(64).max(2048).default(512)
        .describe("Tamanho do arquivo de teste em MB (64 a 2048, padrão 512)"),
    }).strict(),
    executar: (s, v, ctx) => s.servidorTesteDisco(v.mb, ctx.ator),
  },

  // ------------------------------------------------------------- escrita
  {
    nome: "ignorar_incidente",
    metodo: "POST",
    caminho: "/incidentes/:id/ignorar",
    escopo: "escrever",
    descricao: "Marca um incidente como ignorado (falso positivo).",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v, ctx) => s.ignorarIncidente(v.id, ctx.ator),
  },
  {
    nome: "investigar_incidente",
    metodo: "POST",
    caminho: "/incidentes/:id/investigar",
    escopo: "escrever",
    descricao:
      "Pede à IA de investigação um relatório do incidente (histórico de 30 dias do IP/ASN); o relatório fica salvo no incidente.",
    entrada: z.object({ id: Id }).strict(),
    todoNaoConfiavel: true,
    executar: (s, v, ctx) => s.investigarIncidente(v.id, ctx.ator),
  },
  {
    nome: "bloquear_ip",
    metodo: "POST",
    caminho: "/bloqueios",
    escopo: "escrever",
    descricao:
      "Bloqueia um IP em todas as zonas por 24h ou 7d. IPs protegidos (permitidos, do administrador, do Cloudflare) são recusados.",
    entrada: z.object({
      ip: IpTexto,
      duracao: Duracao,
      motivo: z.string().trim().min(1).max(200).optional()
        .describe("Motivo (vai para a auditoria)"),
    }).strict(),
    executar: (s, v, ctx) =>
      s.bloquearIp(
        { ...v, motivo: v.motivo ?? `Bloqueio via API (${ctx.ator})` },
        ctx.ator,
      ),
  },
  {
    nome: "desbloquear_ip",
    metodo: "POST",
    caminho: "/bloqueios/desbloquear",
    escopo: "escrever",
    descricao: "Remove o bloqueio ativo de um IP.",
    entrada: z.object({ ip: IpTexto }).strict(),
    executar: async (s, v, ctx) =>
      s.desbloquear(await s.bloqueioAtivoDoIp(v.ip), ctx.ator),
  },
  {
    nome: "prorrogar_bloqueio",
    metodo: "POST",
    caminho: "/bloqueios/prorrogar",
    escopo: "escrever",
    descricao: "Prorroga o bloqueio ativo de um IP por mais 24h ou 7d.",
    entrada: z.object({ ip: IpTexto, duracao: Duracao }).strict(),
    executar: async (s, v, ctx) =>
      s.prorrogar(
        await s.bloqueioAtivoDoIp(v.ip),
        DIAS_DURACAO[v.duracao as "24h" | "7d"],
        ctx.ator,
      ),
  },
  {
    nome: "adicionar_excecao",
    metodo: "POST",
    caminho: "/excecoes",
    escopo: "escrever",
    descricao:
      'Adiciona uma exceção de caminho (ex.: webhook) às regras Fora do Brasil, de proteções e de limite de login. Termine com * para prefixo. ATENÇÃO: o caminho fica sem essas proteções; uma exceção ampla (prefixo curto) enfraquece a proteção do site inteiro — use o caminho exato do webhook. "/" e "/*" são recusados.',
    entrada: z.object({
      valor: z.string().min(1).max(200).regex(/^\/[^\s"\\]*$/)
        .refine(
          (v) => v !== "/" && v !== "/*",
          'Exceção ampla demais ("/" e "/*" desligariam as proteções)',
        )
        .describe("Caminho começando com /, ex.: /api/webhook*"),
      nota: z.string().max(200).optional(),
    }).strict(),
    executar: (s, v, ctx) =>
      s.adicionarExcecao({ tipo: "caminho", ...v }, ctx.ator),
  },
  {
    nome: "remover_excecao",
    metodo: "DELETE",
    caminho: "/excecoes/:id",
    escopo: "escrever",
    descricao: "Remove uma exceção de caminho pelo id (veja listar_regras).",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v, ctx) => s.removerExcecao(v.id, ctx.ator),
  },
  {
    nome: "adicionar_permitido",
    metodo: "POST",
    caminho: "/permitidos",
    escopo: "escrever",
    descricao:
      "Libera um IP ou CIDR (nunca bloqueado e fora da regra Fora do Brasil), opcionalmente por algumas horas. ATENÇÃO: uma faixa ampla enfraquece a proteção — todo IP dela escapa do bloqueio; prefira o IP exato e uma validade em horas. Faixas maiores que /16 (IPv4) ou /48 (IPv6) são recusadas.",
    entrada: z.object({
      ip: z.string().max(64).refine(ipOuCidrValido, "IP ou CIDR inválido")
        .refine(
          faixaRestrita,
          "Faixa ampla demais para token (máximo /16 em IPv4, /48 em IPv6)",
        )
        .describe("IPv4, IPv6 ou CIDR (IPv4 /16 a /32; IPv6 /48 a /128)"),
      horas: z.number().positive().max(8760).optional()
        .describe("Validade em horas (sem: permanente)"),
      nota: z.string().max(200).optional(),
    }).strict(),
    executar: (s, v, ctx) => s.adicionarPermitido(v, ctx.ator),
  },
  {
    nome: "remover_permitido",
    metodo: "DELETE",
    caminho: "/permitidos/:id",
    escopo: "escrever",
    descricao: "Remove um IP permitido pelo id (veja listar_regras).",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v, ctx) => s.removerPermitido(v.id, ctx.ator),
  },
  {
    nome: "definir_geo",
    metodo: "PUT",
    caminho: "/config/geo",
    escopo: "escrever",
    descricao: "Liga ou desliga a regra Fora do Brasil em todas as zonas.",
    entrada: z.object({ ativo: Ativo }).strict(),
    executar: (s, v, ctx) =>
      resumoGeral(s.definirGeral({ geoAtivo: v.ativo }, ctx.ator)),
  },
  {
    nome: "definir_bloqueio_automatico",
    metodo: "PUT",
    caminho: "/config/bloqueio-automatico",
    escopo: "escrever",
    descricao: "Liga ou desliga o bloqueio automático decidido pelas IAs.",
    entrada: z.object({ ativo: Ativo }).strict(),
    executar: (s, v, ctx) =>
      resumoGeral(s.definirGeral({ bloqueioAutoAtivo: v.ativo }, ctx.ator)),
  },
  {
    nome: "definir_modo_observacao",
    metodo: "PUT",
    caminho: "/config/modo-observacao",
    escopo: "escrever",
    descricao:
      'Liga ou desliga o modo observação (o motor decide, mas só avisa "teria bloqueado").',
    entrada: z.object({ ativo: Ativo }).strict(),
    executar: (s, v, ctx) =>
      resumoGeral(s.definirGeral({ modoObservacao: v.ativo }, ctx.ator)),
  },
  {
    nome: "definir_config_ia",
    metodo: "PUT",
    caminho: "/config/ia",
    escopo: "escrever",
    descricao:
      "Troca o modelo (slug do OpenRouter) e/ou o timeout de um papel de IA.",
    entrada: z.object({
      papel: z.enum(PAPEIS),
      modelo: z.string().regex(/^[\w.\-]+\/[\w.:\-]+$/).max(200).optional()
        .describe("Slug do OpenRouter, ex.: deepseek/deepseek-v4.1-flash"),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
    }).strict(),
    executar: async (s, v, ctx) => {
      const atual = (await s.lerIa()).find((x) => x.papel === v.papel);
      if (!atual) throw new ErroApi(404, { erro: "Papel não encontrado" });
      const r = await s.definirIa([{
        papel: v.papel,
        modelo: v.modelo ?? atual.modelo,
        timeoutMs: v.timeoutMs,
      }], ctx.ator);
      return {
        ok: true,
        antes: r.antes.find((x) => x.papel === v.papel),
        depois: r.depois.find((x) => x.papel === v.papel),
      };
    },
  },
  {
    nome: "definir_decisao",
    metodo: "PUT",
    caminho: "/config/decisao",
    escopo: "escrever",
    descricao:
      "Ajusta a regra de bloqueio automático do Jev: confiança mínima (jevLimiar, 0,3 a 0,95; padrão 0,5) numa classe maliciosa para bloquear por 7 dias e se exige 2ª opinião da mesma classe com a mesma confiança (jevExigeSegunda; padrão false). ATENÇÃO: limiar baixo bloqueia mais IPs legítimos.",
    entrada: z.object({
      jevLimiar: z.number().min(JEV_LIMIAR_MIN).max(JEV_LIMIAR_MAX).optional()
        .describe("Confiança mínima do Jev (0,3 a 0,95)"),
      jevExigeSegunda: z.boolean().optional()
        .describe("true: exige 2ª opinião (segunda/terceira) da mesma classe"),
    }).strict().refine(
      (v) => v.jevLimiar !== undefined || v.jevExigeSegunda !== undefined,
      "Informe jevLimiar e/ou jevExigeSegunda",
    ),
    executar: async (s, v, ctx) => {
      const r = await s.definirGeral(v, ctx.ator);
      return {
        antes: {
          jevLimiar: r.antes.jevLimiar,
          jevExigeSegunda: r.antes.jevExigeSegunda,
        },
        depois: { jevLimiar: r.jevLimiar, jevExigeSegunda: r.jevExigeSegunda },
      };
    },
  },
  {
    nome: "listar_asn_datacenter",
    metodo: "GET",
    caminho: "/asn-datacenter",
    escopo: "escrever",
    descricao:
      'ASNs de datacenter/VPS barrados pela regra "Vigia: fora do Brasil" mesmo vindos do Brasil (exceto bots verificados, IPs permitidos, o host do Vigia e caminhos de exceção), e se o bloqueio de datacenter está ligado.',
    entrada: vazio(),
    executar: (s, _v, ctx) => s.listarAsnDatacenter(ctx.ator),
  },
  {
    nome: "adicionar_asn_datacenter",
    metodo: "POST",
    caminho: "/asn-datacenter",
    escopo: "escrever",
    descricao:
      'Inclui um ASN de nuvem/VPS na regra "Vigia: fora do Brasil" (reaplica em todas as zonas). ATENÇÃO: só redes de hospedagem — um ASN de provedor residencial ou móvel bloqueia clientes reais.',
    entrada: z.object({
      asn: Asn,
      nome: z.string().trim().min(1).max(100)
        .describe("Nome do provedor, ex.: Amazon AWS"),
    }).strict(),
    executar: (s, v, ctx) => s.adicionarAsnDatacenter(v, ctx.ator),
  },
  {
    nome: "remover_asn_datacenter",
    metodo: "DELETE",
    caminho: "/asn-datacenter/:asn",
    escopo: "escrever",
    descricao:
      "Tira um ASN da lista de datacenter/VPS (reaplica a regra em todas as zonas).",
    entrada: z.object({ asn: Asn }).strict(),
    executar: (s, v, ctx) => s.removerAsnDatacenter(v.asn, ctx.ator),
  },
  {
    nome: "definir_bloqueio_datacenter",
    metodo: "PUT",
    caminho: "/config/bloqueio-datacenter",
    escopo: "escrever",
    descricao:
      'Liga ou desliga o bloqueio de IPs de datacenter/VPS (inclusive do Brasil) na regra "Vigia: fora do Brasil". Só vale com a regra Fora do Brasil ligada.',
    entrada: z.object({ ativo: Ativo }).strict(),
    executar: async (s, v, ctx) => {
      const r = await s.definirGeral({ bloquearDatacenter: v.ativo }, ctx.ator);
      return {
        antes: { bloquearDatacenter: r.antes.bloquearDatacenter },
        depois: { bloquearDatacenter: r.bloquearDatacenter },
        zonasComFalha: r.zonasComFalha,
      };
    },
  },
  {
    nome: "definir_protecoes",
    metodo: "PUT",
    caminho: "/protecoes",
    escopo: "escrever",
    descricao:
      "Ajusta as proteções na borda: modo da regra de assinaturas (desligado, observar, bloquear) e o rate limiting dos caminhos de login. Aplica em todas as zonas e informa o que o plano não permitiu.",
    entrada: z.object({
      modo: z.enum(["desligado", "observar", "bloquear"]).optional(),
      rateAtivo: z.boolean().optional()
        .describe(
          "Rate limiting de /auth, /login, /token, /signup, /recover, /otp",
        ),
    }).strict(),
    executar: (s, v, ctx) => s.definirProtecoes(v, ctx.ator),
  },
  {
    nome: "rodar_auditoria",
    metodo: "POST",
    caminho: "/auditoria/rodar",
    escopo: "escrever",
    descricao:
      "Roda agora a auditoria de configuração dos hosts confirmados (em segundo plano; só GET/HEAD, 1 requisição/s por host). Consulte achados_auditoria depois de alguns minutos.",
    entrada: vazio(),
    executar: (s, _v, ctx) => s.rodarAuditoria(ctx.ator),
  },
  {
    nome: "adicionar_host_auditoria",
    metodo: "POST",
    caminho: "/auditoria/hosts",
    escopo: "escrever",
    descricao:
      "Inclui (ou confirma uma sugestão de) host na auditoria diária. Só hosts dentro das zonas Cloudflare do Vigia são aceitos.",
    entrada: z.object({
      host: z.string().trim().min(1).max(253)
        .describe("Nome do host, ex.: app.exemplo.com.br"),
    }).strict(),
    executar: (s, v, ctx) => s.adicionarHostAuditoria(v.host, ctx.ator),
  },
  {
    nome: "remover_host_auditoria",
    metodo: "DELETE",
    caminho: "/auditoria/hosts/:host",
    escopo: "escrever",
    descricao:
      "Tira um host da auditoria (ou recusa uma sugestão; ela não volta sozinha).",
    entrada: z.object({
      host: z.string().trim().min(1).max(253)
        .describe("Nome do host, ex.: app.exemplo.com.br"),
    }).strict(),
    executar: (s, v, ctx) => s.removerHostAuditoria(v.host, ctx.ator),
  },

  // ----------------------------------------- varredura profunda (segura)
  {
    nome: "listar_varredura",
    metodo: "GET",
    caminho: "/varredura",
    escopo: "ler",
    descricao:
      "Achados da varredura de segurança não-destrutiva dos SEUS próprios sites (hosts das zonas do Vigia): portas sensíveis expostas, TLS antigo, cabeçalhos, caminhos expostos, segredos vazados no código público (só o tipo e uma máscara de 4 chars, nunca o segredo) e endpoint de auth do Supabase. Traz também os hosts auditados, com o ambiente (producao/teste).",
    entrada: vazio(),
    executar: (s) => s.listarVarredura(),
  },
  {
    nome: "rodar_varredura",
    metodo: "POST",
    caminho: "/varredura/rodar",
    escopo: "escrever",
    descricao:
      "Roda agora a varredura de segurança completa (checagens básicas + profundas) dos hosts confirmados, só nas zonas do Vigia, em segundo plano, não-destrutiva (GET/HEAD e TCP-connect, ≤ 2 req/s por host). Consulte listar_varredura depois de alguns minutos.",
    entrada: vazio(),
    executar: (s, _v, ctx) => s.rodarVarredura(ctx.ator),
  },
  {
    nome: "achados_revisao",
    metodo: "GET",
    caminho: "/revisao",
    escopo: "ler",
    descricao:
      "Última análise do Revisor IA (papel de IA dedicado 'revisor', caixa-preta): resumo e achados priorizados (host, severidade, risco, menor fix, needs_validation), o modelo usado e quando rodou; e se há uma revisão em andamento. O Revisor raciocina sobre os achados da varredura/auditoria + apps; não lê código-fonte nem executa nada.",
    entrada: vazio(),
    executar: (s) => s.achadosRevisao(),
  },
  {
    nome: "rodar_revisao",
    metodo: "POST",
    caminho: "/revisao/rodar",
    escopo: "escrever",
    descricao:
      "Roda agora o Revisor IA em segundo plano sobre os achados atuais da varredura/auditoria e os apps do EasyPanel. Leva cerca de 1 minuto; consulte achados_revisao depois. Usa o modelo do papel 'revisor' (troque em definir_config_ia).",
    entrada: vazio(),
    executar: (s, _v, ctx) => s.rodarRevisao(ctx.ator),
  },
  {
    nome: "ver_cabecalhos",
    metodo: "GET",
    caminho: "/cabecalhos",
    escopo: "ler",
    descricao:
      "Estado dos cabeçalhos de segurança aplicados pela Cloudflare (regra 'Vigia: cabeçalhos'): modo (desligado/report-only/aplicar) e o resultado por zona da última aplicação.",
    entrada: vazio(),
    executar: (s) => s.verCabecalhos(),
  },
  {
    nome: "definir_cabecalhos",
    metodo: "PUT",
    caminho: "/cabecalhos",
    escopo: "escrever",
    descricao:
      "Aplica os cabeçalhos de segurança (HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, X-Frame-Options, CSP e remove X-Powered-By) em todas as zonas via Transform Rule. Modo: 'report-only' (CSP só reporta, recomendado para começar), 'aplicar' (CSP bloqueia) ou 'desligado'. Regra a regra; nunca mexe em regra alheia.",
    entrada: z.object({
      modo: z.enum(["desligado", "report-only", "aplicar"]),
    }).strict(),
    executar: (s, v, ctx) => s.definirCabecalhos(v.modo, ctx.ator),
  },
  {
    nome: "achados_supabase",
    metodo: "GET",
    caminho: "/supabase",
    escopo: "ler",
    descricao:
      "Auditoria anônima das instâncias Supabase self-hosted cadastradas: por instância, tabelas expostas pelo PostgREST, tabelas legíveis sem login (RLS aberto — só nº/nome de colunas, nunca o dado), signup aberto, /auth/v1/admin/users exposto, buckets anônimos e funções RPC do anon; com severidade e recomendação. Lista também as instâncias cadastradas (sem a chave).",
    entrada: vazio(),
    executar: (s) => s.achadosSupabase(),
  },
  {
    nome: "cadastrar_supabase",
    metodo: "POST",
    caminho: "/supabase",
    escopo: "escrever",
    descricao:
      "Cadastra (ou atualiza) uma instância Supabase para auditar: nome, URL (https) e a ANON key (pública, nunca a service key). A service key não é usada nem aceita.",
    entrada: z.object({
      nome: z.string().trim().min(1).max(60),
      url: z.string().trim().url().max(300),
      anonKey: z.string().trim().min(10).max(600).describe(
        "Anon key pública (JWT eyJ… ou sb_publishable_…)",
      ),
    }).strict(),
    executar: (s, v, ctx) =>
      s.adicionarSupabase(v.nome, v.url, v.anonKey, ctx.ator),
  },
  {
    nome: "remover_supabase",
    metodo: "DELETE",
    caminho: "/supabase/:nome",
    escopo: "escrever",
    descricao: "Remove uma instância Supabase da auditoria.",
    entrada: z.object({ nome: z.string().trim().min(1).max(60) }).strict(),
    executar: (s, v, ctx) => s.removerSupabase(v.nome, ctx.ator),
  },
  {
    nome: "auditar_supabase",
    metodo: "POST",
    caminho: "/supabase/auditar",
    escopo: "escrever",
    descricao:
      "Roda agora a auditoria anônima de todas as instâncias Supabase cadastradas (em segundo plano, só GET e leitura de settings; nunca executa RPC nem lê dado de linha). Consulte achados_supabase depois.",
    entrada: vazio(),
    executar: (s, _v, ctx) => s.auditarSupabaseAgora(ctx.ator),
  },
  {
    nome: "pedidos_conector",
    metodo: "GET",
    caminho: "/conector",
    escopo: "ler",
    descricao:
      "Pedidos de liberação de conector: transações de conector (MCP/OAuth/admin) de origem desconhecida que o Vigia detectou e está perguntando o que fazer. Por pedido: faixa (/24 ou /48), IP, origem, caminho e estado (pendente, temporario, permanente, bloqueado). A faixa da Anthropic e os vendedores (OpenAI/Codex) já são liberados e não aparecem como pedido.",
    entrada: vazio(),
    executar: (s) => s.pedidosConector(),
  },
  {
    nome: "decidir_conector",
    metodo: "POST",
    caminho: "/conector/decidir",
    escopo: "escrever",
    descricao:
      "Decide uma faixa de conector: 'temporario' libera por N horas (padrão 24), 'permanente' libera para sempre, 'bloquear' mantém barrada. Informe a faixa (ex.: 203.0.113.0/24) OU o id do pedido. Aplica na allowlist e reaplica a regra de skip na borda.",
    entrada: z.object({
      faixa: z.string().trim().min(3).max(60).optional().describe(
        "Faixa CIDR do pedido (ex.: 203.0.113.0/24). Informe faixa ou id.",
      ),
      id: z.number().int().positive().optional().describe(
        "Id do pedido (alternativa à faixa).",
      ),
      modo: z.enum(["temporario", "permanente", "bloquear"]),
      horas: z.number().int().positive().max(8760).optional().describe(
        "Só para 'temporario': horas de liberação (padrão 24).",
      ),
    }).strict().refine((v) => v.faixa || v.id !== undefined, {
      message: "informe faixa ou id",
    }),
    executar: (s, v, ctx) =>
      s.decidirConector(
        { faixa: v.faixa, id: v.id, modo: v.modo, horas: v.horas },
        ctx.ator,
      ),
  },
  {
    nome: "achados_codigo",
    metodo: "GET",
    caminho: "/codigo",
    escopo: "ler",
    descricao:
      "Análises de CÓDIGO do Revisor IA (repos subidos por zip ou analisados por link do GitHub): por análise, o repo, a origem, o modelo, o resumo e os achados (arquivo, linha, severidade, risco, menor fix, needs_validation). O Revisor só lê o fonte; nunca executa.",
    entrada: vazio(),
    executar: (s) => s.achadosCodigo(),
  },
  {
    nome: "analisar_repo",
    metodo: "POST",
    caminho: "/codigo/github",
    escopo: "escrever",
    descricao:
      "Analisa um repositório PÚBLICO do GitHub com o Revisor IA: baixa o zipball (só github.com/codeload, SSRF-safe), lê o fonte e devolve achados de segurança. Em segundo plano; consulte achados_codigo depois. Para zip enviado, use o app (upload).",
    entrada: z.object({
      url: z.string().trim().url().max(300).describe(
        "Link do repo, ex.: https://github.com/dono/repo (ou /tree/<ref>)",
      ),
    }).strict(),
    executar: (s, v, ctx) => s.analisarRepoGithub(v.url, ctx.ator),
  },
  {
    nome: "definir_ambiente_host",
    metodo: "PUT",
    caminho: "/auditoria/hosts/:host/ambiente",
    escopo: "escrever",
    descricao:
      "Marca um host auditado como producao ou teste. Só hosts marcados como teste (e dentro das zonas do Vigia) podem ser alvo de campanhas de teste ofensivo.",
    entrada: z.object({
      host: z.string().trim().min(1).max(253)
        .describe("Nome do host, ex.: staging.exemplo.com.br"),
      ambiente: z.enum(["producao", "teste"]),
    }).strict(),
    executar: (s, v, ctx) =>
      s.definirAmbienteHost(v.host, v.ambiente, ctx.ator),
  },

  // ------------------------------- campanhas de teste ofensivo (staging)
  {
    nome: "listar_campanhas",
    metodo: "GET",
    caminho: "/ataque",
    escopo: "escrever",
    descricao:
      "Lista as campanhas de teste ofensivo. Elas só podem mirar hosts de teste/staging SEUS (das zonas do Vigia, marcados como ambiente=teste); produção é sempre recusada. Nenhuma exploração destrutiva roda a partir do Vigia.",
    entrada: vazio(),
    executar: (s) => s.listarCampanhas(),
  },
  {
    nome: "ver_campanha",
    metodo: "GET",
    caminho: "/ataque/:id",
    escopo: "escrever",
    descricao:
      "Detalhe e resultado de uma campanha de teste ofensivo (só contra staging seu).",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v) => s.verCampanha(v.id),
  },
  {
    nome: "criar_campanha",
    metodo: "POST",
    caminho: "/ataque",
    escopo: "escrever",
    descricao:
      "Cria (em rascunho) uma campanha de teste ofensivo contra um host de teste/staging SEU (das zonas do Vigia, ambiente=teste; produção é recusada). Tipos seguros: enumeracao (varredura mais agressiva de caminhos), fuzz_leve (GET com query malformada, só status), forca_bruta_simulada (testa o SEU rate limit de login com credenciais falsas; exige config.caminho). Devolve um token de confirmação para autorizar. Nada destrutivo roda a partir do Vigia.",
    entrada: z.object({
      alvo: z.string().trim().min(1).max(300)
        .describe("Hostname ou URL de um host de teste/staging seu"),
      tipo: z.enum([
        "forca_bruta_simulada",
        "fuzz_leve",
        "enumeracao",
      ]),
      config: z.object({
        caminho: z.string().trim().max(300).optional()
          .describe("forca_bruta_simulada: caminho do login, ex.: /api/login"),
        caminhos: z.array(z.string().trim().max(300)).max(10).optional()
          .describe("fuzz_leve: caminhos GET a fuzzar"),
      }).strict().optional(),
    }).strict(),
    executar: (s, v, ctx) => s.criarCampanha(v, ctx.ator),
  },
  {
    nome: "autorizar_campanha",
    metodo: "POST",
    caminho: "/ataque/:id/autorizar",
    escopo: "escrever",
    descricao:
      "Autoriza uma campanha em rascunho. Exige o token de confirmação devolvido na criação e revalida o gate (o host ainda precisa ser de teste/staging seu).",
    entrada: z.object({
      id: Id,
      confirmar: z.string().min(1).max(100)
        .describe("Token de confirmação devolvido ao criar a campanha"),
    }).strict(),
    executar: (s, v, ctx) => s.autorizarCampanha(v.id, v.confirmar, ctx.ator),
  },
  {
    nome: "rodar_campanha",
    metodo: "POST",
    caminho: "/ataque/:id/rodar",
    escopo: "escrever",
    descricao:
      "Roda uma campanha AUTORIZADA, revalidando o gate (host de teste/staging seu). Só executa checagens ativas seguras (nada de exploit destrutivo) e grava o resultado. A exploração real exige um runner isolado que você opta por usar à parte.",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v, ctx) => s.rodarCampanha(v.id, ctx.ator),
  },
  {
    nome: "cancelar_campanha",
    metodo: "POST",
    caminho: "/ataque/:id/cancelar",
    escopo: "escrever",
    descricao: "Cancela uma campanha em rascunho ou autorizada.",
    entrada: z.object({ id: Id }).strict(),
    executar: (s, v, ctx) => s.cancelarCampanha(v.id, ctx.ator),
  },
];

async function resumoGeral(
  p: Promise<{
    antes: {
      geoAtivo: boolean;
      bloqueioAutoAtivo: boolean;
      modoObservacao: boolean;
    };
    geoAtivo: boolean;
    bloqueioAutoAtivo: boolean;
    modoObservacao: boolean;
    zonasComFalha: string[];
  }>,
) {
  const r = await p;
  return {
    antes: {
      geoAtivo: r.antes.geoAtivo,
      bloqueioAutoAtivo: r.antes.bloqueioAutoAtivo,
      modoObservacao: r.antes.modoObservacao,
    },
    depois: {
      geoAtivo: r.geoAtivo,
      bloqueioAutoAtivo: r.bloqueioAutoAtivo,
      modoObservacao: r.modoObservacao,
    },
    zonasComFalha: r.zonasComFalha,
  };
}

/** JSON Schema (entrada) de uma operação, sem o "$schema". */
export function esquemaEntrada(op: Operacao): Record<string, unknown> {
  const { $schema: _s, ...resto } = z.toJSONSchema(op.entrada, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return resto;
}

/** Mensagem pt-BR do primeiro problema de validação. */
export function problemaValidacao(e: z.ZodError): string {
  return e.issues.slice(0, 3).map((i) =>
    `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`
  ).join("; ");
}
