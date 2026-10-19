export type Evento = {
  zonaId: number;
  ts: Date;
  ip: string;
  pais: string;
  asn: number;
  host: string;
  caminho: string;
  metodo: string;
  status: number;
  ua: string;
  acaoCf: string;
  fonte: "firewall" | "http";
  contagem: number;
  /** Descrição da regra do Cloudflare que agiu (firewall), ex.: "Vigia: fora do Brasil". */
  regraCf?: string;
};

export type Sinal = {
  tipo:
    | "geo"
    | "geo_passou"
    | "datacenter"
    | "bruteforce"
    | "scan"
    | "rate"
    | "ua"
    | "scrape";
  ip: string;
  zonaId: number;
  host: string;
  severidade: "baixa" | "media" | "alta";
  amostra: string[];
  contagem: number;
  ts: Date;
  /** ASN de origem (0/ausente = desconhecido; nunca agrupa por ele). */
  asn?: number;
};

export type Severidade = "baixa" | "media" | "alta";

/**
 * Sinais que a regra da borda "Vigia: fora do Brasil" já barra (estrangeiro e
 * datacenter/VPS): incidente só com eles é registrado, sem IA nem bloqueio.
 */
export const TIPOS_BORDA: ReadonlySet<Sinal["tipo"]> = new Set([
  "geo",
  "datacenter",
]);
export const soBorda = (sinais: Pick<Sinal, "tipo">[]) =>
  sinais.length > 0 && sinais.every((s) => TIPOS_BORDA.has(s.tipo));

export type Incidente = {
  id?: number;
  chave: string;
  ips: string[];
  zonaIds: number[];
  hosts: string[];
  inicio: Date;
  fim: Date;
  sinais: Sinal[];
  severidadeMax: Severidade;
  /** Total de sinais já agrupados (sinais guarda só os MAX_SINAIS mais recentes). */
  totalSinais: number;
  /** Soma de Sinal.contagem de todos os sinais agrupados. */
  contagemTotal: number;
};
