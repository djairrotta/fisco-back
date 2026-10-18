import { z } from "zod";

/**
 * Booleano de variavel de ambiente.
 *
 * NAO usar z.coerce.boolean(): ele faz Boolean(string), e Boolean("false")
 * e TRUE. Toda string nao vazia vira verdadeiro, entao AGENDADOR_ATIVO=false
 * LIGAVA o agendador e RECEITA_AUTO=false LIGAVA a carga da Receita --
 * exatamente o oposto do que o arquivo de ambiente dizia, e sem nenhum
 * aviso. Aqui "false", "0", "no", "off" e vazio sao falsos, como qualquer
 * pessoa que escreve um .env espera.
 */
const booleano = (padrao: boolean) =>
  z.preprocess((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined || v === null) return padrao;
    const t = String(v).trim().toLowerCase();
    if (["false", "0", "no", "nao", "não", "off", ""].includes(t)) return false;
    if (["true", "1", "yes", "sim", "on"].includes(t)) return true;
    return padrao;
  }, z.boolean());

const schema = z.object({
  DATABASE_URL: z.string(),
  PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().min(8),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  OPENROUTER_API_KEY: z.string().optional(),
  MODELO_PREENCHIMENTO: z.string().default("anthropic/claude-haiku-5.5"),
  MODELO_PREENCHIMENTO_FALLBACK: z.string().default("deepseek/deepseek-v4.1-flash"),
  RACIOCINIO_DESLIGADO: booleano(true),
  HERMES_BASE_URL: z.string().optional(),
  NEXUS_BASE_URL: z.string().optional(),
  NEXUS_API_KEY: z.string().optional(),
  DJEN_BASE_URL: z.string().optional(),
  DATAJUD_API_KEY: z.string().optional(),
  IANDAMENTO_BASE_URL: z.string().optional(),
  IANDAMENTO_API_KEY: z.string().optional(),
  JEV_BASE_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_REMETENTE: z.string().default("no-reply@fisco.judinfo.com.br"),
  POSTEIO_BASE_URL: z.string().optional(),
  POSTEIO_AUTH: z.string().optional(),
  OPENWA_BASE_URL: z.string().optional(),
  OPENWA_API_KEY: z.string().optional(),
  ASAAS_API_KEY: z.string().optional(),

  // Enriquecimento por CNPJ (consulta avulsa, nao carga em massa).
  APIBRASIL_TOKEN: z.string().optional(),
  INFOSIMPLES_TOKEN: z.string().optional(),
  INFOSIMPLES_BASE_URL: z.string().default("https://api.infosimples.com/api/v2/consultas"),

  // Agendador de cargas. Desligado por padrao: so o container que deve
  // carregar liga isto, senao duas replicas baixam 1,4 GB cada.
  AGENDADOR_ATIVO: booleano(false),
  AGENDADOR_HORA: z.coerce.number().min(0).max(23).default(4),
  PGFN_AUTO: booleano(true),
  // Serie historica da PGFN (todos os trimestres desde 2020). Roda depois
  // das cargas do dia, um trimestre por vez, ate completar a fila.
  PGFN_HISTORICO: booleano(true),
  RECEITA_AUTO: booleano(false),
  /** Carga por diferenca de toda a Receita (todas as empresas, com MEI/Simples, socios). */
  RECEITA_COMPLETA: booleano(true),
});

export const env = schema.parse(process.env);
