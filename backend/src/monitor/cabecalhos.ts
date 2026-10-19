// Cabeçalhos de segurança aplicados pela Cloudflare (fase
// http_response_headers_transform), uma regra "Vigia: cabeçalhos" por zona.
// Tri-estado: desligado / report-only (CSP em Report-Only) / aplicar (CSP
// bloqueando). Regra a regra, com o mesmo garantirRegraZona das proteções:
// nunca mexe em regra de outra descrição.
import type { CfApi } from "../cloudflare/client.ts";
import { FASE_HEADERS, garantirRegraZona, type RegraCf } from "./executor.ts";

export type ModoCabecalhos = "desligado" | "report-only" | "aplicar";
export const MODOS_CABECALHOS: ModoCabecalhos[] = [
  "desligado",
  "report-only",
  "aplicar",
];
export const DESCRICAO_CABECALHOS = "Vigia: cabeçalhos";

/** Cabeçalhos estáticos (sempre) + a CSP, cujo nome muda com o modo. */
const ESTATICOS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "X-Frame-Options": "SAMEORIGIN",
};
const CSP_VALOR = "default-src 'self'; frame-ancestors 'self'";
const REMOVER = ["X-Powered-By"];

/**
 * Monta a regra de cabeçalhos para o modo. `report-only` usa
 * Content-Security-Policy-Report-Only; `aplicar` usa Content-Security-Policy.
 * `desligado` devolve a regra desabilitada (mantém, não apaga).
 */
export function regraCabecalhos(
  modo: Exclude<ModoCabecalhos, "desligado"> | "desligado",
): RegraCf {
  const headers: Record<string, { operation: string; value?: string }> = {};
  for (const [k, v] of Object.entries(ESTATICOS)) {
    headers[k] = { operation: "set", value: v };
  }
  const nomeCsp = modo === "aplicar"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
  headers[nomeCsp] = { operation: "set", value: CSP_VALOR };
  for (const r of REMOVER) headers[r] = { operation: "remove" };
  return {
    description: DESCRICAO_CABECALHOS,
    expression: "true",
    action: "rewrite",
    enabled: modo !== "desligado",
    action_parameters: { headers },
  };
}

export interface ResultadoZonaCabecalhos {
  zona: string;
  estado: "criada" | "atualizada" | "inalterada" | "desligada" | "erro";
  detalhe?: string;
}

/**
 * Aplica (ou desliga) a regra de cabeçalhos em cada zona. Não derruba as outras
 * zonas se uma falhar (ex.: plano sem Transform Rules): marca erro e segue.
 */
export async function sincronizarCabecalhos(
  api: CfApi,
  modo: ModoCabecalhos,
  zonas: string[],
): Promise<ResultadoZonaCabecalhos[]> {
  const regra = regraCabecalhos(modo === "desligado" ? "desligado" : modo);
  const out: ResultadoZonaCabecalhos[] = [];
  for (const zona of zonas) {
    try {
      const r = await garantirRegraZona(api, zona, regra, FASE_HEADERS);
      out.push({
        zona,
        estado: modo === "desligado" ? "desligada" : r,
      });
    } catch (e) {
      out.push({ zona, estado: "erro", detalhe: (e as Error)?.message });
    }
  }
  return out;
}
