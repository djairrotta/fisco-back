import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string(),
  PORT: z.coerce.number().default(3000),
  JWT_SECRET: z.string().min(8),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  OPENROUTER_API_KEY: z.string().optional(),
  MODELO_PREENCHIMENTO: z.string().default("anthropic/claude-haiku-5.5"),
  MODELO_PREENCHIMENTO_FALLBACK: z.string().default("deepseek/deepseek-v4.1-flash"),
  RACIOCINIO_DESLIGADO: z.coerce.boolean().default(true),
  HERMES_BASE_URL: z.string().optional(),
  NEXUS_BASE_URL: z.string().optional(),
  NEXUS_API_KEY: z.string().optional(),
  DJEN_BASE_URL: z.string().optional(),
  DATAJUD_API_KEY: z.string().optional(),
});

export const env = schema.parse(process.env);
