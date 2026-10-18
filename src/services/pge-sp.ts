/**
 * API oficial da Divida Ativa da PGE-SP (pge-divida-ativa v1.0.0), publicada
 * no Integrador de APIs do SP.GOV.BR / Portal de APIs da Prodesp.
 * Endpoints usados:
 *   GET /empresas/{cnpj}/situacao-fiscal   situacao fiscal da empresa
 *   GET /debitos?{param}={cnpj}            debitos inscritos (lista)
 * Acesso por assinatura no gateway: OAuth2 client_credentials
 * (PGE_SP_TOKEN_URL + PGE_SP_CLIENT_ID + PGE_SP_CLIENT_SECRET) ou chave
 * fixa (PGE_SP_API_KEY, no cabecalho PGE_SP_API_KEY_HEADER). Sem isso,
 * a consulta estadual continua pela Infosimples.
 */
const BASE = () => (process.env.PGE_SP_API_URL || "").replace(/\/$/, "");

let token: { valor: string; expira: number } | null = null;

async function cabecalhos(): Promise<Record<string, string>> {
  const h: Record<string, string> = { accept: "application/json" };
  if (process.env.PGE_SP_API_KEY) h[process.env.PGE_SP_API_KEY_HEADER || "apikey"] = process.env.PGE_SP_API_KEY;
  if (process.env.PGE_SP_TOKEN_URL && process.env.PGE_SP_CLIENT_ID) {
    if (!token || token.expira < Date.now() + 30_000) {
      const r = await fetch(process.env.PGE_SP_TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic " + Buffer.from(`${process.env.PGE_SP_CLIENT_ID}:${process.env.PGE_SP_CLIENT_SECRET ?? ""}`).toString("base64"),
        },
        body: "grant_type=client_credentials" + (process.env.PGE_SP_SCOPE ? `&scope=${encodeURIComponent(process.env.PGE_SP_SCOPE)}` : ""),
        signal: AbortSignal.timeout(20_000),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) throw new Error(`token PGE-SP ${r.status}`);
      token = { valor: d.access_token, expira: Date.now() + (Number(d.expires_in) || 300) * 1000 };
    }
    h.authorization = `Bearer ${token.valor}`;
  }
  return h;
}

export const pgeSpConfigurada = () => !!BASE() && !!(process.env.PGE_SP_API_KEY || process.env.PGE_SP_CLIENT_ID);

const numeroBr = (v: unknown) => {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/[^\d,.-]/g, "");
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : 0;
};
/** Primeiro array de objetos dentro da resposta (a API pagina em envelope). */
function lista(d: any): any[] {
  if (Array.isArray(d)) return d;
  for (const k of ["debitos", "itens", "items", "content", "data", "resultado", "registros"]) if (Array.isArray(d?.[k])) return d[k];
  const a = d && typeof d === "object" ? Object.values(d).find((v) => Array.isArray(v)) : null;
  return (a as any[]) ?? [];
}
const valorDe = (x: any) => numeroBr(x?.valorTotal ?? x?.valor_total ?? x?.valorAtualizado ?? x?.saldo ?? x?.valor ?? 0);

async function obter(caminho: string) {
  const r = await fetch(`${BASE()}${caminho}`, { headers: await cabecalhos(), signal: AbortSignal.timeout(60_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`PGE-SP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

export async function consultarPgeSp(cnpj: string) {
  const [situacao, debitos] = await Promise.all([
    obter(`/empresas/${cnpj}/situacao-fiscal`).catch((e) => ({ erro: String(e.message ?? e) })),
    obter(`/debitos?${process.env.PGE_SP_PARAM_CNPJ || "cnpj"}=${cnpj}`),
  ]);
  const itens = lista(debitos);
  const valor = itens.reduce((s, x) => s + valorDe(x), 0);
  return { tem_debito: itens.length > 0, valor_total: valor, quantidade: itens.length, detalhe: { situacao, debitos: itens } };
}
