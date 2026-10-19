import type { Config } from "../config.ts";

const BASE = "https://api.cloudflare.com/client/v4";

export class CfError extends Error {
  status: number;
  messages: string[];
  constructor(status: number, messages: string[]) {
    super(`Cloudflare API (${status}): ${messages.join("; ") || "erro"}`);
    this.name = "CfError";
    this.status = status;
    this.messages = messages;
  }
}

export interface CfApi {
  graphql<T>(query: string, vars: object): Promise<T>;
  rest<T>(method: string, path: string, body?: unknown): Promise<T>;
}

type Msg = { message?: string };

export function createCfApi(
  cfg: Pick<Config, "cfApiToken">,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 30_000,
): CfApi {
  const headers = {
    "Authorization": `Bearer ${cfg.cfApiToken}`,
    "Content-Type": "application/json",
  };
  async function call(url: string, init: RequestInit): Promise<any> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timeout = () => new CfError(0, [`timeout após ${timeoutMs} ms`]);
    let res: Response;
    let json: any = null;
    try {
      res = await fetchFn(url, { ...init, headers, signal });
      try {
        json = await res.json();
      } catch (e) {
        if (signal.aborted) throw e;
        /* corpo não-JSON */
      }
    } catch (e) {
      if (signal.aborted) throw timeout();
      throw new CfError(0, [`falha de rede: ${(e as Error).message}`]);
    }
    const msgs = (arr?: Msg[]) =>
      (arr ?? []).map((m) => m.message ?? "").filter(Boolean);
    if (!res.ok) {
      throw new CfError(
        res.status,
        msgs(json?.errors).length ? msgs(json.errors) : [res.statusText],
      );
    }
    if (json === null) throw new CfError(res.status, ["resposta inválida"]);
    return json;
  }
  return {
    async graphql<T>(query: string, vars: object): Promise<T> {
      const json = await call(`${BASE}/graphql`, {
        method: "POST",
        body: JSON.stringify({ query, variables: vars }),
      });
      if (json.errors?.length) {
        throw new CfError(200, json.errors.map((e: Msg) => e.message ?? ""));
      }
      return json.data as T;
    },
    async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
      const json = await call(`${BASE}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (json.success === false) {
        throw new CfError(
          200,
          (json.errors ?? []).map((e: Msg) => e.message ?? ""),
        );
      }
      return json.result as T;
    },
  };
}
