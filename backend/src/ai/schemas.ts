import { z } from "zod";

export const Classe = z.enum([
  "invasao",
  "raspagem",
  "forca_bruta",
  "varredura",
  "credential_stuffing",
  "benigno",
  "incerto",
]);

export const ParecerSchema = z.object({
  incidente_chave: z.string(),
  classe: Classe,
  confianca: z.number().min(0).max(1),
  // Texto longo é truncado (não invalida o parecer).
  justificativa: z.string().transform((s) => s.slice(0, 800)),
});

export const JevSaidaSchema = z.object({
  anomalias: z.array(z.object({
    host: z.string(),
    descricao: z.string(),
    gravidade: z.enum(["baixa", "media", "alta"]),
  })),
  classificacao_incidentes: z.array(ParecerSchema),
});

export type ParecerIA = z.infer<typeof ParecerSchema>;
export type JevSaida = z.infer<typeof JevSaidaSchema>;
