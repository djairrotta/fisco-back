export class ApiError extends Error {
  constructor(public status: number, public corpo: unknown) {
    super(
      (corpo && typeof corpo === "object" && "erro" in corpo
        ? String((corpo as { erro: unknown }).erro)
        : status === 0 ? "Sem conexão com o servidor" : `HTTP ${status}`),
    );
    this.name = "ApiError";
  }
}

/** 409 da caixa com senha recusada (pool/envio devolvem `precisaSenha: true`). */
export const ehPrecisaSenha = (e: unknown): boolean =>
  e instanceof ApiError &&
  !!(e.corpo && typeof e.corpo === "object" && (e.corpo as { precisaSenha?: unknown }).precisaSenha);

function lerCorpo(texto: string): unknown {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/** Apaga tudo o que o Correio guarda no aparelho (rascunhos, endereços, última caixa). */
export function limparDadosLocais(): void {
  try {
    const chaves: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("correio:")) chaves.push(k);
    }
    for (const k of chaves) localStorage.removeItem(k);
  } catch { /* sem armazenamento */ }
}

/**
 * Sessão expirada: limpa os dados locais e vai ao login. As rotas
 * /api/auth/* não redirecionam — o 401 delas é um erro a mostrar
 * (ex.: cadastrar passkey nos Ajustes).
 */
function tratar401(status: number, path: string) {
  if (status !== 401 || path.startsWith("/api/auth/")) return;
  limparDadosLocais();
  if (location.pathname !== "/login") location.assign("/login");
}

async function chamar<T>(metodo: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method: metodo, credentials: "include" };
  if (metodo !== "GET") {
    // CSRF: toda chamada mutante (inclusive DELETE) leva Content-Type JSON e corpo JSON ({} se vazio).
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  } else {
    init.headers = { Accept: "application/json" };
  }
  const r = await fetch(path, init);
  const corpo = lerCorpo(await r.text());
  tratar401(r.status, path);
  if (!r.ok) throw new ApiError(r.status, corpo);
  return corpo as T;
}

/** Upload multipart (logo/favicon). O navegador manda Sec-Fetch-Site: same-origin. */
async function enviarForm<T>(metodo: string, path: string, form: FormData): Promise<T> {
  const r = await fetch(path, { method: metodo, credentials: "include", body: form });
  const corpo = lerCorpo(await r.text());
  tratar401(r.status, path);
  if (!r.ok) throw new ApiError(r.status, corpo);
  return corpo as T;
}

/**
 * POST multipart via XHR para ter progresso de upload (fetch não expõe).
 * `progresso` recebe 0..1.
 */
export function enviarComProgresso<T>(
  path: string,
  form: FormData,
  progresso: (f: number) => void,
): Promise<T> {
  return new Promise<T>((ok, falha) => {
    const x = new XMLHttpRequest();
    x.open("POST", path);
    x.withCredentials = true;
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) progresso(e.loaded / e.total);
    };
    x.onload = () => {
      const corpo = lerCorpo(x.responseText);
      tratar401(x.status, path);
      if (x.status >= 200 && x.status < 300) {
        progresso(1);
        ok(corpo as T);
      } else falha(new ApiError(x.status, corpo));
    };
    x.onerror = () => falha(new ApiError(0, { erro: "Sem conexão com o servidor; o rascunho foi mantido." }));
    x.ontimeout = x.onerror;
    x.send(form);
  });
}

export const api = {
  get: <T>(path: string) => chamar<T>("GET", path),
  post: <T>(path: string, body?: unknown) => chamar<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => chamar<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => chamar<T>("PATCH", path, body),
  del: <T>(path: string, body?: unknown) => chamar<T>("DELETE", path, body),
  form: <T>(metodo: "PUT" | "POST", path: string, form: FormData) => enviarForm<T>(metodo, path, form),
};
export const get = api.get;
export const post = api.post;
export const put = api.put;
export const del = api.del;
