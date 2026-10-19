export class ApiError extends Error {
  constructor(public status: number, public corpo: unknown) {
    super(
      (corpo && typeof corpo === "object" && "erro" in corpo
        ? String((corpo as { erro: unknown }).erro)
        : `HTTP ${status}`),
    );
    this.name = "ApiError";
  }
}

async function chamar<T>(metodo: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: metodo, credentials: "include" };
  if (metodo !== "GET") {
    // CSRF: toda chamada mutante leva Content-Type JSON e corpo JSON ({} se vazio).
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  } else {
    init.headers = { Accept: "application/json" };
  }
  const r = await fetch(path, init);
  const texto = await r.text();
  let corpo: unknown = null;
  if (texto) {
    try {
      corpo = JSON.parse(texto);
    } catch {
      corpo = texto;
    }
  }
  if (r.status === 401 && location.pathname !== "/login") {
    // Consentimento OAuth: depois da passkey, volta para a mesma página.
    location.assign(
      location.pathname.startsWith("/oauth/")
        ? `/login?voltar=${encodeURIComponent(location.pathname + (location.search ?? ""))}`
        : "/login",
    );
  }
  if (!r.ok) throw new ApiError(r.status, corpo);
  return corpo as T;
}

export const api = {
  get: <T>(path: string) => chamar<T>("GET", path),
  post: <T>(path: string, body?: unknown) => chamar<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => chamar<T>("PUT", path, body),
  del: <T>(path: string, body?: unknown) => chamar<T>("DELETE", path, body),
};
export const get = api.get;
export const post = api.post;
export const put = api.put;
export const del = api.del;
