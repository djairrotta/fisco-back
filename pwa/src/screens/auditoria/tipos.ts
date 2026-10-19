/** Classifica uma verificação da varredura num dos tipos da auditoria profunda. */
export type TipoAchado =
  | "porta" | "tls" | "cabecalho" | "exposto" | "segredo_publico" | "cors" | "supabase" | "outros";

export const TIPO_ROTULO: Record<TipoAchado, string> = {
  porta: "Portas expostas",
  tls: "TLS",
  cabecalho: "Cabeçalhos",
  exposto: "Arquivos expostos",
  segredo_publico: "Segredos vazados",
  cors: "CORS",
  supabase: "Supabase",
  outros: "Outros",
};

const ORDEM: TipoAchado[] = [
  "segredo_publico", "exposto", "supabase", "porta", "tls", "cors", "cabecalho", "outros",
];

export function tipoDe(verificacao: string): TipoAchado {
  const v = verificacao.toLowerCase();
  if (v.startsWith("porta")) return "porta";
  if (v.startsWith("tls")) return "tls";
  if (v.startsWith("cabecalho") || v.startsWith("cabeçalho") || v.startsWith("cookie")) return "cabecalho";
  if (v.startsWith("exposto") || v.startsWith("arquivo")) return "exposto";
  if (v.startsWith("segredo")) return "segredo_publico";
  if (v.startsWith("cors")) return "cors";
  if (v.startsWith("supabase")) return "supabase";
  return "outros";
}

export interface AchadoTipado {
  id: number; verificacao: string; severidade: "baixa" | "media" | "alta";
  titulo: string; recomendacao: string; evidencia: string | null;
  firstSeen: string | null; lastSeen: string | null;
}

/** Agrupa achados de um host por tipo, na ordem de gravidade/relevância. */
export function porTipo(achados: AchadoTipado[]): { tipo: TipoAchado; achados: AchadoTipado[] }[] {
  const mapa = new Map<TipoAchado, AchadoTipado[]>();
  for (const a of achados) {
    const t = tipoDe(a.verificacao);
    if (!mapa.has(t)) mapa.set(t, []);
    mapa.get(t)!.push(a);
  }
  return ORDEM.filter((t) => mapa.has(t)).map((t) => ({ tipo: t, achados: mapa.get(t)! }));
}
