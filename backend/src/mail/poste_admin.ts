// Importação das caixas do poste.io pela API de administração (rede interna do
// EasyPanel, sem passar pelo Cloudflare Access). Só lê a lista de caixas: o
// Correio NUNCA altera nada no poste.io (nem senhas).
//
// Env (todas opcionais; sem POSTE_ADMIN_USUARIO/SENHA a importação fica desligada):
//   POSTE_ADMIN_URL      padrão http://<IMAP_HOST>:8080 (porta HTTP do poste.io)
//   POSTE_ADMIN_USUARIO  e-mail de um administrador do poste.io
//   POSTE_ADMIN_SENHA    senha desse administrador
//   POSTE_SENHA_CAIXAS   senha usada para entrar nas caixas importadas

export interface ConfigPosteAdmin {
  url: string;
  usuario: string;
  senha: string;
  senhaCaixas: string | null;
}

export function configPosteAdmin(imapHost: string): ConfigPosteAdmin | null {
  const usuario = (Deno.env.get("POSTE_ADMIN_USUARIO") ?? "").trim();
  const senha = Deno.env.get("POSTE_ADMIN_SENHA") ?? "";
  if (!usuario || !senha) return null;
  const url = (Deno.env.get("POSTE_ADMIN_URL") ?? `http://${imapHost}:8080`).replace(/\/$/, "");
  const sc = Deno.env.get("POSTE_SENHA_CAIXAS") ?? "";
  return { url, usuario, senha, senhaCaixas: sc || null };
}

export interface CaixaPoste {
  endereco: string;
  nome: string;
  desativada: boolean;
}

export class ErroPosteAdmin extends Error {
  constructor(m: string, public status = 502) {
    super(m);
    this.name = "ErroPosteAdmin";
  }
}

type Fetch = typeof fetch;

/** Lista todas as caixas (todas as páginas) de GET /admin/api/v1/boxes. */
export async function listarCaixasPoste(
  cfg: ConfigPosteAdmin,
  f: Fetch = fetch,
): Promise<CaixaPoste[]> {
  const auth = "Basic " + btoa(`${cfg.usuario}:${cfg.senha}`);
  const out: CaixaPoste[] = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    let r: Response;
    try {
      r = await f(`${cfg.url}/admin/api/v1/boxes?page=${pagina}&paging=200`, {
        headers: { Authorization: auth, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ErroPosteAdmin(`poste.io não respondeu em ${cfg.url} (${(e as Error).message})`);
    }
    if (r.status === 401 || r.status === 403) {
      throw new ErroPosteAdmin("poste.io recusou o login de administrador (POSTE_ADMIN_USUARIO/POSTE_ADMIN_SENHA)", 401);
    }
    if (!r.ok) throw new ErroPosteAdmin(`poste.io respondeu HTTP ${r.status}`);
    // deno-lint-ignore no-explicit-any
    const j: any = await r.json().catch(() => null);
    const itens = Array.isArray(j?.results) ? j.results : Array.isArray(j) ? j : [];
    for (const b of itens) {
      const endereco = String(b?.address ?? b?.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(endereco)) continue;
      out.push({
        endereco,
        nome: String(b?.name ?? "").trim(),
        desativada: b?.disabled === true,
      });
    }
    const ultima = Number(j?.last_page ?? 1);
    if (!Number.isFinite(ultima) || pagina >= ultima || itens.length === 0) break;
  }
  return out;
}
