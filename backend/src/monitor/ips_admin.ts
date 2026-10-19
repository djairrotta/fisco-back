import type { Sql } from "../db/client.ts";
import { ipValido } from "./decision.ts";

/** Por quanto tempo o IP de uso do administrador continua protegido. */
export const TTL_IP_ADMIN_MS = 7 * 86_400_000;

/**
 * Por quanto tempo o IP de login autenticado (passkey) fica isento da regra de
 * geo/datacenter na BORDA (vigia.permitidos). Renovado a cada requisição
 * autenticada enquanto o admin estiver ativo (a PWA faz polling a cada
 * ~20 s), então na prática não expira em uso; some em até 24 h de
 * inatividade — ex.: dispositivo perdido/roubado.
 */
export const TTL_GEO_ADMIN_MS = 24 * 3_600_000;
export const NOTA_ADMIN_AUTO = "admin (login automático)";

/** Upsert do IP de uma requisição autenticada. Nunca lança. */
export async function registrarIpAdmin(
  sql: Sql,
  ip: string,
  agora: Date,
): Promise<void> {
  try {
    await sql`INSERT INTO vigia.ips_admin (ip, visto_em)
      VALUES (${ip}::inet, ${agora})
      ON CONFLICT (ip) DO UPDATE SET visto_em = GREATEST(vigia.ips_admin.visto_em, EXCLUDED.visto_em)`;
  } catch (e) {
    console.error(
      `ips_admin: registro de ${ip} falhou: ${(e as Error).message}`,
    );
  }
}

/** IPs do administrador vistos nos últimos 7 dias (sem /32,/128). */
export async function ipsAdminVigentes(
  sql: Sql,
  agora: Date,
): Promise<string[]> {
  const desde = new Date(agora.getTime() - TTL_IP_ADMIN_MS);
  const rows = await sql`SELECT host(ip) ip FROM vigia.ips_admin
    WHERE visto_em > ${desde}`;
  return rows.map((r) => String(r.ip));
}

/**
 * Login autenticado (passkey) também isenta o IP da regra de geo/datacenter na
 * BORDA, não só do bloqueio por incidente: insere/renova uma linha em
 * vigia.permitidos com TTL_GEO_ADMIN_MS, sem sobrescrever uma nota já existente
 * (ex.: um "modo viagem" manual) — mesmo padrão de ON CONFLICT do modo viagem.
 * Devolve true só quando o IP NÃO estava isento antes (novo ou tinha expirado):
 * é o sinal para o chamador reaplicar a regra na Cloudflare agora, em vez de
 * esperar a sincronização horária. Nunca lança.
 */
export async function liberarIpAdminGeo(
  sql: Sql,
  ip: string,
  agora: Date,
  ttlMs: number = TTL_GEO_ADMIN_MS,
): Promise<boolean> {
  if (!ipValido(ip)) return false;
  try {
    const [antes] = await sql`
      SELECT 1 FROM vigia.permitidos
      WHERE ip = ${ip}::inet AND (expira IS NULL OR expira > ${agora})`;
    const expira = new Date(agora.getTime() + ttlMs);
    await sql`
      INSERT INTO vigia.permitidos (ip, expira, nota)
      VALUES (${ip}::inet, ${expira}, ${NOTA_ADMIN_AUTO})
      ON CONFLICT (ip) DO UPDATE SET
        expira = CASE WHEN vigia.permitidos.expira IS NULL THEN NULL
          ELSE GREATEST(vigia.permitidos.expira, EXCLUDED.expira) END,
        nota = COALESCE(vigia.permitidos.nota, EXCLUDED.nota)`;
    return !antes;
  } catch (e) {
    console.error(
      `ips_admin: liberar geo de ${ip} falhou: ${(e as Error).message}`,
    );
    return false;
  }
}
