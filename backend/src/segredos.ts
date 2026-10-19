// Segredos automáticos: gera na primeira subida e persiste no volume de dados,
// para o deploy não exigir geração manual de chaves. Env sempre tem precedência.
import webpush from "web-push";
import type { Sql } from "./db/client.ts";
import { VIGIA_HOST_PADRAO } from "./config.ts";

export const ARQUIVO_SEGREDOS = "vigia-segredos.json";
export const DIR_DADOS_PADRAO = "/data";
export const VAPID_SUBJECT_PADRAO = "mailto:djair@djairrotta.com.br";

type Env = Record<string, string | undefined>;
type Salvos = Record<string, string>;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function lerSalvos(arquivo: string): Promise<Salvos> {
  let txt: string;
  try {
    txt = await Deno.readTextFile(arquivo);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return {};
    throw e;
  }
  let v: unknown;
  try {
    v = JSON.parse(txt);
  } catch {
    // Nunca regenerar: uma chave mestra nova invalidaria os segredos cifrados.
    throw new Error(
      `${arquivo} está corrompido (JSON inválido). Restaure o backup ou apague-o conscientemente.`,
    );
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${arquivo} não contém um objeto JSON`);
  }
  const out: Salvos = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === "string") out[k] = x;
  }
  return out;
}

function erroNaoGravavel(dir: string, e: unknown): Error {
  return new Error(
    `Não consigo gravar em ${dir} (${(e as Error)?.message ?? e}). ` +
      `O Vigia guarda ali as chaves geradas (${ARQUIVO_SEGREDOS}). ` +
      `No EasyPanel, abra o serviço → Montagens (Mounts) → adicione uma montagem do tipo "Volume" ` +
      `(não "Bind"), nome vigia-dados, caminho de montagem ${dir}, e implante de novo. ` +
      `Alternativa: defina VIGIA_MASTER_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY e VIGIA_INVITE_CODE no ambiente.`,
  );
}

/** Garante que o dir de dados existe e aceita escrita; senão, erro claro. */
async function exigirGravavel(dir: string) {
  const sonda = `${dir}/.vigia-sonda-escrita`;
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.remove(sonda).catch(() => {});
    await Deno.writeTextFile(sonda, "ok", { createNew: true, mode: 0o600 });
    await Deno.remove(sonda);
  } catch (e) {
    throw erroNaoGravavel(dir, e);
  }
}

async function gravarSalvos(dir: string, arquivo: string, s: Salvos) {
  const tmp = `${arquivo}.tmp`;
  try {
    // .tmp de uma subida interrompida (ou symlink plantado): remove antes.
    await Deno.remove(tmp).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    await Deno.writeTextFile(tmp, JSON.stringify(s, null, 2) + "\n", {
      createNew: true,
      mode: 0o600,
    });
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, arquivo);
  } catch (e) {
    throw erroNaoGravavel(dir, e);
  }
}

/**
 * Completa o env com VIGIA_MASTER_KEY, VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY e
 * VIGIA_INVITE_CODE (gerados uma vez e reutilizados de `<dir>/vigia-segredos.json`,
 * 0600) e com os padrões de VAPID_SUBJECT, VIGIA_HOST e WEBAUTHN_*.
 */
export async function garantirSegredos(
  env: Env,
  dir = DIR_DADOS_PADRAO,
): Promise<Record<string, string>> {
  const get = (k: string) => (env[k]?.trim() ? env[k]!.trim() : undefined);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;

  const temVapid = get("VAPID_PUBLIC_KEY") !== undefined &&
    get("VAPID_PRIVATE_KEY") !== undefined;
  const precisa = get("VIGIA_MASTER_KEY") === undefined || !temVapid ||
    get("VIGIA_INVITE_CODE") === undefined;

  if (precisa) {
    const arquivo = `${dir}/${ARQUIVO_SEGREDOS}`;
    await exigirGravavel(dir);
    const salvos = await lerSalvos(arquivo);
    let mudou = false;
    if (!salvos.VIGIA_MASTER_KEY) {
      salvos.VIGIA_MASTER_KEY = b64(rand(32));
      mudou = true;
    }
    if (!salvos.VAPID_PUBLIC_KEY || !salvos.VAPID_PRIVATE_KEY) {
      const v = webpush.generateVAPIDKeys();
      salvos.VAPID_PUBLIC_KEY = v.publicKey;
      salvos.VAPID_PRIVATE_KEY = v.privateKey;
      mudou = true;
    }
    if (!salvos.VIGIA_INVITE_CODE) {
      salvos.VIGIA_INVITE_CODE = hex(rand(16));
      mudou = true;
    }
    if (mudou) {
      await gravarSalvos(dir, arquivo, salvos);
      console.log(`segredos: gerados e salvos em ${arquivo}`);
    } else {
      try {
        if (((await Deno.stat(arquivo)).mode ?? 0) & 0o077) {
          await Deno.chmod(arquivo, 0o600);
        }
      } catch (e) {
        console.error(`segredos: não consegui ajustar a permissão: ${e}`);
      }
    }

    if (get("VIGIA_MASTER_KEY") === undefined) {
      out.VIGIA_MASTER_KEY = salvos.VIGIA_MASTER_KEY;
    }
    if (!temVapid) {
      if (
        get("VAPID_PUBLIC_KEY") !== undefined ||
        get("VAPID_PRIVATE_KEY") !== undefined
      ) {
        console.error(
          "segredos: só uma das chaves VAPID veio no ambiente; usando o par salvo",
        );
      }
      out.VAPID_PUBLIC_KEY = salvos.VAPID_PUBLIC_KEY;
      out.VAPID_PRIVATE_KEY = salvos.VAPID_PRIVATE_KEY;
    }
    if (get("VIGIA_INVITE_CODE") === undefined) {
      out.VIGIA_INVITE_CODE = salvos.VIGIA_INVITE_CODE;
    }
  }

  const host = get("VIGIA_HOST") ?? VIGIA_HOST_PADRAO;
  out.VIGIA_HOST = host;
  out.VAPID_SUBJECT = get("VAPID_SUBJECT") ?? VAPID_SUBJECT_PADRAO;
  const rpId = get("WEBAUTHN_RP_ID") ?? host;
  out.WEBAUTHN_RP_ID = rpId;
  out.WEBAUTHN_ORIGIN = get("WEBAUTHN_ORIGIN") ?? `https://${rpId}`;
  return out;
}

/** Linha de destaque para o log enquanto nenhuma passkey foi cadastrada. */
export async function mensagemPrimeiroAcesso(
  sql: Sql,
  host: string,
  convite: string,
): Promise<string | null> {
  const [r] = await sql`SELECT count(*)::int n FROM vigia.passkeys`;
  if (Number(r?.n ?? 0) > 0) return null;
  const linha = "=".repeat(72);
  return [
    linha,
    `PRIMEIRO ACESSO: https://${host}/login?convite=${
      encodeURIComponent(convite)
    }`,
    "Abra este link no iPhone (Safari) e cadastre o Face ID.",
    linha,
  ].join("\n");
}
